import { PassThrough, Readable } from 'node:stream';
import { createInterface } from 'node:readline';

import Dockerode from 'dockerode';

import type {
  ContainerRuntimeEvent,
  ContainerDetails,
  CreateContainerOptions,
  DockerRuntime,
  RuntimeLogLine,
  RuntimeEventOptions,
  RuntimeLogOptions
} from './runtime.js';
import { MANAGED_LABELS, MANAGED_OWNER } from './runtime.js';

function parseSince(input: string | undefined): number | undefined {
  if (!input) {
    return undefined;
  }

  const asNumber = Number(input);
  if (Number.isFinite(asNumber)) {
    return Math.max(0, Math.floor(asNumber));
  }

  const asDate = new Date(input);
  if (Number.isNaN(asDate.getTime())) {
    return undefined;
  }

  return Math.floor(asDate.getTime() / 1000);
}

function parseTail(input: number | undefined): number | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Number.isFinite(input)) {
    return undefined;
  }
  return Math.max(1, Math.floor(input));
}

const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

function parseSecondsToEpochNanos(input: string): bigint | undefined {
  const match = input.match(/^([0-9]+)(?:\.([0-9]+))?$/);
  if (!match) {
    return undefined;
  }

  const seconds = BigInt(match[1]);
  const fraction = (match[2] ?? '').slice(0, 9).padEnd(9, '0');

  return seconds * NANOSECONDS_PER_SECOND + BigInt(fraction || '0');
}

function parseTimestampToEpochNanos(input: string | undefined): bigint | undefined {
  if (!input) {
    return undefined;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  const secondsNanos = parseSecondsToEpochNanos(trimmed);
  if (secondsNanos !== undefined) {
    return secondsNanos;
  }

  const zuluMatch = trimmed.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.([0-9]{1,9}))?Z$/
  );
  if (zuluMatch) {
    const wholeSecondsMs = Date.parse(`${zuluMatch[1]}Z`);
    if (Number.isNaN(wholeSecondsMs)) {
      return undefined;
    }

    const fraction = (zuluMatch[2] ?? '').padEnd(9, '0');
    return BigInt(wholeSecondsMs) * NANOSECONDS_PER_MILLISECOND + BigInt(fraction || '0');
  }

  const asDateMs = Date.parse(trimmed);
  if (Number.isNaN(asDateMs)) {
    return undefined;
  }

  return BigInt(asDateMs) * NANOSECONDS_PER_MILLISECOND;
}

function parseLogLine(line: string): { timestamp: string; message: string } | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const [timestamp, ...parts] = trimmed.split(' ');
  if (!timestamp || parts.length === 0) {
    return null;
  }

  return {
    timestamp,
    message: parts.join(' ')
  };
}

function parseMuxedLogBuffer(
  input: Buffer
): Array<{ stream: 'stdout' | 'stderr'; payload: string }> | null {
  const frames: Array<{ stream: 'stdout' | 'stderr'; payload: string }> = [];
  let offset = 0;

  while (offset < input.length) {
    if (offset + 8 > input.length) {
      return null;
    }

    const streamType = input[offset];
    const size = input.readUInt32BE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > input.length) {
      return null;
    }

    const stream: 'stdout' | 'stderr' = streamType === 2 ? 'stderr' : 'stdout';
    frames.push({
      stream,
      payload: input.toString('utf8', payloadStart, payloadEnd)
    });
    offset = payloadEnd;
  }

  return frames;
}

interface DockerContainerEventPayload {
  id?: string;
  Action?: string;
  status?: string;
  time?: number;
  timeNano?: number;
  Actor?: {
    ID?: string;
    Attributes?: Record<string, string>;
  };
}

/** Executes Docker operations through Docker Engine API via dockerode. */
export class DockerodeRuntime implements DockerRuntime {
  private readonly docker: Dockerode;

  constructor(docker?: Dockerode) {
    this.docker = docker ?? new Dockerode();
  }

  async createNetwork(name: string, labels: Record<string, string>): Promise<void> {
    await this.docker.createNetwork({
      Name: name,
      Labels: labels
    });
  }

  async createVolume(name: string, labels: Record<string, string>): Promise<void> {
    await this.docker.createVolume({
      Name: name,
      Labels: labels
    });
  }

  async createContainer(options: CreateContainerOptions): Promise<string> {
    await this.ensureImageInstalled(options.image);

    const hostConfig: Record<string, unknown> = {
      Mounts: [
        {
          Type: 'volume',
          Source: options.volumeName,
          Target: '/workspace'
        }
      ],
      NetworkMode: options.networkName
    };
    if (options.devices?.length) {
      hostConfig.Devices = options.devices;
    }
    if (options.capAdd?.length) {
      hostConfig.CapAdd = options.capAdd;
    }

    const container = await this.docker.createContainer({
      name: options.name,
      Image: options.image,
      Cmd: options.command,
      Env: Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`),
      Labels: options.labels,
      HostConfig: hostConfig
    });
    return container.id;
  }

  private async ensureImageInstalled(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode !== 404) {
        throw error;
      }
    }
    throw new Error(
      `Runtime image not found locally: ${image}. Build/tag it first (try: npm run build:runtime-image).`
    );
  }

  async startContainer(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).start();
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 304) {
        // Docker returns 304 when a container is already started; treat as idempotent success.
        return;
      }
      throw error;
    }
  }

  async stopContainer(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).stop();
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 304) {
        // Docker returns 304 when a container is already stopped; treat as idempotent success.
        return;
      }
      throw error;
    }
  }

  async removeContainer(containerId: string): Promise<void> {
    await this.docker.getContainer(containerId).remove({ force: true });
  }

  async removeNetwork(name: string): Promise<void> {
    await this.docker.getNetwork(name).remove();
  }

  async removeVolume(name: string): Promise<void> {
    await this.docker.getVolume(name).remove();
  }

  async inspectContainer(containerId: string): Promise<ContainerDetails | null> {
    try {
      const details = await this.docker.getContainer(containerId).inspect();
      return {
        id: details.Id,
        labels: details.Config?.Labels ?? {},
        status: details.State?.Status ?? 'unknown'
      };
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async *streamContainerLogs(
    containerId: string,
    options: RuntimeLogOptions
  ): AsyncIterable<RuntimeLogLine> {
    const container = this.docker.getContainer(containerId);
    const since = parseSince(options.since);
    const sinceCursorNanos = parseTimestampToEpochNanos(options.since);
    const tail = parseTail(options.tail);
    const shouldIncludeTimestamp = (timestamp: string): boolean => {
      if (sinceCursorNanos === undefined) {
        return true;
      }

      const lineTimestampNanos = parseTimestampToEpochNanos(timestamp);
      if (lineTimestampNanos === undefined) {
        return true;
      }

      return lineTimestampNanos > sinceCursorNanos;
    };

    const raw = options.follow
      ? await container.logs({
          follow: true,
          stdout: true,
          stderr: true,
          timestamps: true,
          since,
          tail
        })
      : await container.logs({
          follow: false,
          stdout: true,
          stderr: true,
          timestamps: true,
          since,
          tail
        });

    if (Buffer.isBuffer(raw)) {
      const parsedFrames = parseMuxedLogBuffer(raw);
      if (parsedFrames) {
        for (const frame of parsedFrames) {
          for (const line of frame.payload.split('\n')) {
            const parsed = parseLogLine(line);
            if (!parsed || !shouldIncludeTimestamp(parsed.timestamp)) {
              continue;
            }
            yield {
              stream: frame.stream,
              timestamp: parsed.timestamp,
              line: parsed.message
            };
          }
        }
        return;
      }

      const text = raw.toString('utf8');
      for (const line of text.split('\n')) {
        const parsed = parseLogLine(line);
        if (!parsed || !shouldIncludeTimestamp(parsed.timestamp)) {
          continue;
        }
        yield {
          stream: 'stdout',
          timestamp: parsed.timestamp,
          line: parsed.message
        };
      }
      return;
    }

    const rawAsString = typeof (raw as unknown) === 'string' ? (raw as unknown as string) : null;
    if (rawAsString !== null) {
      for (const line of rawAsString.split('\n')) {
        const parsed = parseLogLine(line);
        if (!parsed || !shouldIncludeTimestamp(parsed.timestamp)) {
          continue;
        }
        yield {
          stream: 'stdout',
          timestamp: parsed.timestamp,
          line: parsed.message
        };
      }
      return;
    }

    const stream = raw as Readable & {
      destroy?: (error?: Error) => void;
      destroyed?: boolean;
    };
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    this.docker.modem.demuxStream(stream, stdout, stderr);

    const queue: RuntimeLogLine[] = [];
    const waiters: Array<() => void> = [];
    let ended = false;
    let streamError: Error | null = null;
    let aborted = false;

    const wake = (): void => {
      const waiter = waiters.shift();
      if (waiter) {
        waiter();
      }
    };

    const cleanupAbort = (): void => {
      options.signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      aborted = true;
      ended = true;
      stdoutReader.close();
      stderrReader.close();
      if (typeof stream.destroy === 'function') {
        stream.destroy();
      }
      wake();
    };

    const onLine = (which: 'stdout' | 'stderr', line: string): void => {
      const parsed = parseLogLine(line);
      if (!parsed || !shouldIncludeTimestamp(parsed.timestamp)) {
        return;
      }
      queue.push({
        stream: which,
        timestamp: parsed.timestamp,
        line: parsed.message
      });
      wake();
    };

    const stdoutReader = createInterface({ input: stdout as Readable });
    const stderrReader = createInterface({ input: stderr as Readable });
    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true });
    }

    stdoutReader.on('line', (line) => onLine('stdout', line));
    stderrReader.on('line', (line) => onLine('stderr', line));

    stream.on('end', () => {
      ended = true;
      wake();
    });
    stream.on('close', () => {
      ended = true;
      wake();
    });
    stream.on('error', (error) => {
      streamError = error instanceof Error ? error : new Error(String(error));
      ended = true;
      wake();
    });

    try {
      while (!ended || queue.length > 0) {
        if (aborted) {
          break;
        }
        if (queue.length > 0) {
          const event = queue.shift();
          if (event) {
            yield event;
          }
          continue;
        }

        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }

      if (streamError && !aborted) {
        throw streamError;
      }
    } finally {
      cleanupAbort();
      stdoutReader.close();
      stderrReader.close();
      if (!stream.destroyed && typeof stream.destroy === 'function') {
        stream.destroy();
      }
    }
  }

  async *streamContainerEvents(
    options: RuntimeEventOptions = {}
  ): AsyncIterable<ContainerRuntimeEvent> {
    const stream = (await this.docker.getEvents({
      filters: {
        type: ['container'],
        label: [
          `${MANAGED_LABELS.managed}=true`,
          `${MANAGED_LABELS.owner}=${MANAGED_OWNER}`
        ]
      },
      abortSignal: options.signal
    })) as NodeJS.ReadableStream & { destroy?: () => void };
    const reader = createInterface({ input: stream as Readable });

    try {
      for await (const line of reader) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        let payload: DockerContainerEventPayload;
        try {
          payload = JSON.parse(trimmed) as DockerContainerEventPayload;
        } catch {
          continue;
        }

        const attributes = payload.Actor?.Attributes ?? {};
        const containerId = payload.id ?? payload.Actor?.ID;
        const action = payload.Action ?? payload.status;
        if (!containerId || !action) {
          continue;
        }

        const timestamp =
          payload.timeNano !== undefined
            ? new Date(Math.floor(payload.timeNano / 1_000_000)).toISOString()
            : payload.time !== undefined
              ? new Date(payload.time * 1_000).toISOString()
              : new Date().toISOString();

        yield {
          containerId,
          action,
          labels: attributes,
          timestamp
        };
      }
    } finally {
      reader.close();
      if (typeof stream.destroy === 'function') {
        stream.destroy();
      }
    }
  }
}
