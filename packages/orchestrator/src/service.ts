import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { JobRunner } from './job-runner.js';
import type { Box, BoxRepository, CreateBoxInput, DockerRuntime, Job, JobRepository, LogEvent } from './types.js';

const NAME_PATTERN = /^[a-z0-9-]{3,40}$/;

export class OrchestratorService {
  constructor(
    private readonly runtime: DockerRuntime,
    private readonly boxes: BoxRepository,
    private readonly jobs: JobRepository,
    private readonly runner = new JobRunner(),
    private readonly bus = new EventEmitter()
  ) {}

  events() { return this.bus; }

  async createBox(input: CreateBoxInput): Promise<{ box: Box; job: Job }> {
    if (!NAME_PATTERN.test(input.name)) throw new Error('invalid name');
    if (!input.image.includes(':')) throw new Error('image must be tag-pinned');

    const id = randomUUID();
    const box = await this.boxes.create({
      id,
      name: input.name,
      image: input.image,
      status: 'creating',
      containerId: null,
      networkName: `devbox-net-${id}`,
      volumeName: `devbox-vol-${id}`,
      tailnetUrl: null
    });
    const job = await this.jobs.create({
      id: randomUUID(),
      type: 'create',
      status: 'queued',
      boxId: box.id,
      progress: 0,
      message: 'Queued create',
      error: null
    });
    this.emit(job, box);

    void this.runner.enqueue(async () => {
      await this.jobs.update(job.id, { status: 'running', progress: 20, startedAt: new Date().toISOString(), message: 'Creating resources' });
      this.emit(await this.jobs.getById(job.id), await this.boxes.getById(box.id));
      const out = await this.runtime.createManagedResources({
        boxId: box.id,
        name: box.name,
        image: box.image,
        labels: {
          'com.devbox.managed': 'true',
          'com.devbox.box_id': box.id,
          'com.devbox.owner': 'orchestrator'
        }
      });
      const updatedBox = await this.boxes.update(box.id, { status: 'running', containerId: out.containerId });
      const updatedJob = await this.jobs.update(job.id, { status: 'succeeded', progress: 100, message: 'Created', finishedAt: new Date().toISOString() });
      this.emit(updatedJob, updatedBox);
    });

    return { box, job };
  }

  async listBoxes(): Promise<Box[]> { return this.boxes.list(); }
  async getBox(boxId: string): Promise<Box | null> { return this.boxes.getById(boxId); }

  async stopBox(boxId: string): Promise<Job> {
    return this.enqueueBoxJob(boxId, 'stop', async () => {
      await this.boxes.update(boxId, { status: 'stopping' });
      await this.runtime.stopManagedContainer(boxId);
      return this.boxes.update(boxId, { status: 'stopped' });
    });
  }

  async removeBox(boxId: string): Promise<Job> {
    return this.enqueueBoxJob(boxId, 'remove', async () => {
      await this.boxes.update(boxId, { status: 'removing' });
      await this.runtime.removeManagedResources(boxId);
      return this.boxes.update(boxId, { status: 'stopped', deletedAt: new Date().toISOString() });
    });
  }

  async listJobs(): Promise<Job[]> { return this.jobs.list(); }
  async getJob(jobId: string): Promise<Job | null> { return this.jobs.getById(jobId); }
  streamBoxLogs(boxId: string): AsyncIterable<LogEvent> { return this.runtime.streamLogs(boxId); }

  private async enqueueBoxJob(boxId: string, type: 'stop' | 'remove', fn: () => Promise<Box>): Promise<Job> {
    const box = await this.getBox(boxId);
    if (!box || box.deletedAt) throw new Error('box not found');
    const job = await this.jobs.create({ id: randomUUID(), type, status: 'queued', boxId, progress: 0, message: `Queued ${type}`, error: null });
    this.emit(job, box);
    void this.runner.enqueue(async () => {
      await this.jobs.update(job.id, { status: 'running', startedAt: new Date().toISOString(), progress: 30, message: `${type} in progress` });
      this.emit(await this.jobs.getById(job.id), await this.boxes.getById(boxId));
      const updatedBox = await fn();
      const updatedJob = await this.jobs.update(job.id, { status: 'succeeded', progress: 100, message: `${type} complete`, finishedAt: new Date().toISOString() });
      this.emit(updatedJob, updatedBox);
    });
    return job;
  }

  private emit(job: Job | null, box: Box | null): void {
    if (job) this.bus.emit('job.updated', job);
    if (box) this.bus.emit('box.updated', box);
  }
}
