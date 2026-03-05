import { randomUUID } from 'node:crypto';

import { NotFoundError, SecurityError, ValidationError } from './errors.js';
import type { OrchestratorEvents } from './events.js';
import { JobRunner, publishJob } from './job-runner.js';
import type { BoxRepository, JobRepository } from './repositories.js';
import { assertManaged, managedLabels, type DockerRuntime } from './runtime.js';
import type {
  Box,
  BoxFilter,
  CreateBoxInput,
  CreateBoxResult,
  Job,
  JobFilter,
  LogEvent,
  LogOptions
} from './types.js';
import { validateCreateBoxInput } from './validation.js';

function networkName(boxId: string): string {
  return `devbox-net-${boxId}`;
}

function volumeName(boxId: string): string {
  return `devbox-vol-${boxId}`;
}

function containerName(boxId: string): string {
  return `devbox-${boxId}`;
}

/** Coordinates box lifecycle operations, jobs, logs, and security checks. */
export class DevboxOrchestrator {
  constructor(
    private readonly runtime: DockerRuntime,
    private readonly boxes: BoxRepository,
    private readonly jobs: JobRepository,
    private readonly jobRunner: JobRunner,
    readonly events: OrchestratorEvents
  ) {}

  async createBox(input: CreateBoxInput): Promise<CreateBoxResult> {
    validateCreateBoxInput(input);

    const existing = this.boxes.getByName(input.name);
    if (existing && !existing.deletedAt) {
      throw new ValidationError(`Box name already exists: ${input.name}`);
    }

    const id = randomUUID();
    const box = this.boxes.create({
      id,
      name: input.name,
      image: input.image,
      status: 'creating',
      networkName: networkName(id),
      volumeName: volumeName(id)
    });
    this.publishBox(box);

    const job = this.jobs.create({
      type: 'create',
      status: 'queued',
      boxId: id,
      progress: 0,
      message: 'Create requested'
    });
    publishJob(this.events, job);

    this.jobRunner.enqueue(job.id, async (ctx) => {
      ctx.setProgress(10, 'Creating network');
      await this.runtime.createNetwork(box.networkName, managedLabels(box.id));

      ctx.setProgress(30, 'Creating volume');
      await this.runtime.createVolume(box.volumeName, managedLabels(box.id));

      ctx.setProgress(55, 'Creating container');
      const containerId = await this.runtime.createContainer({
        name: containerName(box.id),
        image: box.image,
        networkName: box.networkName,
        volumeName: box.volumeName,
        labels: managedLabels(box.id),
        env: input.env,
        command: input.command
      });

      const creating = this.boxes.update(box.id, {
        containerId,
        status: 'creating'
      });
      this.publishBox(creating);

      ctx.setProgress(80, 'Starting container');
      await this.runtime.startContainer(containerId);

      const running = this.boxes.update(box.id, {
        status: 'running'
      });
      this.publishBox(running);
    });

    return { box, job };
  }

  async listBoxes(filter?: BoxFilter): Promise<Box[]> {
    return this.boxes.list(filter);
  }

  async getBox(boxId: string): Promise<Box | null> {
    return this.boxes.get(boxId);
  }

  async stopBox(boxId: string): Promise<Job> {
    const box = this.requireBox(boxId);

    const stopping = this.boxes.update(boxId, { status: 'stopping' });
    this.publishBox(stopping);

    const job = this.jobs.create({
      type: 'stop',
      status: 'queued',
      boxId,
      progress: 0,
      message: 'Stop requested'
    });
    publishJob(this.events, job);

    this.jobRunner.enqueue(job.id, async (ctx) => {
      if (box.containerId) {
        ctx.setProgress(50, 'Stopping container');
        await this.assertManagedContainer(box.id, box.containerId);
        await this.runtime.stopContainer(box.containerId);
      }

      const stopped = this.boxes.update(box.id, { status: 'stopped' });
      this.publishBox(stopped);
    });

    return job;
  }

  async removeBox(boxId: string): Promise<Job> {
    const box = this.requireBox(boxId);
    const removing = this.boxes.update(boxId, { status: 'removing' });
    this.publishBox(removing);

    const job = this.jobs.create({
      type: 'remove',
      status: 'queued',
      boxId,
      progress: 0,
      message: 'Remove requested'
    });
    publishJob(this.events, job);

    this.jobRunner.enqueue(job.id, async (ctx) => {
      if (box.containerId) {
        ctx.setProgress(30, 'Removing container');
        await this.assertManagedContainer(box.id, box.containerId);
        await this.runtime.removeContainer(box.containerId);
      }

      ctx.setProgress(65, 'Removing network');
      await this.runtime.removeNetwork(box.networkName);

      ctx.setProgress(85, 'Removing volume');
      await this.runtime.removeVolume(box.volumeName);

      const deleted = this.boxes.update(box.id, {
        status: 'stopped',
        containerId: null,
        deletedAt: new Date().toISOString()
      });
      this.publishBox(deleted);
    });

    return job;
  }

  async listJobs(filter?: JobFilter): Promise<Job[]> {
    return this.jobs.list(filter);
  }

  async getJob(jobId: string): Promise<Job | null> {
    return this.jobs.get(jobId);
  }

  async *streamBoxLogs(boxId: string, options: LogOptions): AsyncIterable<LogEvent> {
    const box = this.requireBox(boxId);
    if (!box.containerId) {
      throw new ValidationError('Box has no container logs yet.');
    }

    await this.assertManagedContainer(box.id, box.containerId);

    for await (const item of this.runtime.streamContainerLogs(box.containerId, options)) {
      const log: LogEvent = {
        boxId,
        stream: item.stream,
        line: item.line,
        timestamp: item.timestamp
      };
      this.events.emit('box.logs', { type: 'box.logs', boxId, log });
      yield log;
    }
  }

  private requireBox(boxId: string): Box {
    const box = this.boxes.get(boxId);
    if (!box || box.deletedAt) {
      throw new NotFoundError(`Box not found: ${boxId}`);
    }
    return box;
  }

  private async assertManagedContainer(boxId: string, containerId: string): Promise<void> {
    const details = await this.runtime.inspectContainer(containerId);
    if (!details) {
      throw new NotFoundError(`Container not found: ${containerId}`);
    }

    try {
      assertManaged(details.labels, boxId);
    } catch {
      throw new SecurityError('Refusing operation on unmanaged container.');
    }
  }

  private publishBox(box: Box): void {
    this.events.emit('box.updated', {
      type: 'box.updated',
      box
    });
  }
}
