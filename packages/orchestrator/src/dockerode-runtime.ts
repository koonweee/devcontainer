import { PassThrough, Readable } from 'node:stream';
import { createInterface } from 'node:readline';

import Dockerode from 'dockerode';

import type {
  ContainerDetails,
  CreateContainerOptions,
  DockerRuntime,
  RuntimeLogLine,
  RuntimeLogOptions
} from './runtime.js';

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
    await this.ensureImage(options.image);

    const container = await this.docker.createContainer({
      name: options.name,
      Image: options.image,
      Cmd: options.command,
      Env: Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`),
      Labels: options.labels,
      HostConfig: {
        Mounts: [
          {
            Type: 'volume',
            Source: options.volumeName,
            Target: '/workspace'
          }
        ],
        NetworkMode: options.networkName
      }
    });
    return container.id;
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode !== 404) {
        throw error;
      }
    }

    const pullStream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(pullStream, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async startContainer(containerId: string): Promise<void> {
    await this.docker.getContainer(containerId).start();
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
    const raw = options.follow
      ? await container.logs({
          follow: true,
          stdout: true,
          stderr: true,
          timestamps: true,
          since
        })
      : await container.logs({
          follow: false,
          stdout: true,
          stderr: true,
          timestamps: true,
          since
        });

    if (Buffer.isBuffer(raw) || typeof raw === 'string') {
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
      for (const line of text.split('\n')) {
        const parsed = parseLogLine(line);
        if (!parsed) {
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

    const stream = raw;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    this.docker.modem.demuxStream(stream, stdout, stderr);

    const queue: RuntimeLogLine[] = [];
    const waiters: Array<() => void> = [];
    let ended = false;
    let streamError: Error | null = null;

    const wake = (): void => {
      const waiter = waiters.shift();
      if (waiter) {
        waiter();
      }
    };

    const onLine = (which: 'stdout' | 'stderr', line: string): void => {
      const parsed = parseLogLine(line);
      if (!parsed) {
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

    while (!ended || queue.length > 0) {
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

    stdoutReader.close();
    stderrReader.close();

    if (streamError) {
      throw streamError;
    }
  }
}
