import type { JobRepository } from './repositories.js';
import type { Job } from './types.js';
import type { OrchestratorEvents } from './events.js';

export interface JobTaskContext {
  setProgress(progress: number, message: string): void;
}

export type JobTask = (context: JobTaskContext) => Promise<void>;

interface QueueItem {
  jobId: string;
  task: JobTask;
}

function timestamp(): string {
  return new Date().toISOString();
}

/** Runs queued orchestration jobs and publishes state transitions. */
export class JobRunner {
  private readonly queue: QueueItem[] = [];
  private processing = false;

  constructor(
    private readonly jobs: JobRepository,
    private readonly events: OrchestratorEvents
  ) {}

  enqueue(jobId: string, task: JobTask): void {
    this.queue.push({ jobId, task });
    this.process().catch((error) => {
      // Unhandled queue errors are recorded at job level by processItem.
      console.error('Job runner loop failed', error);
    });
  }

  private async process(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) {
          break;
        }
        await this.processItem(item);
      }
    } finally {
      this.processing = false;
    }
  }

  private async processItem(item: QueueItem): Promise<void> {
    let job = this.jobs.update(item.jobId, {
      status: 'running',
      message: 'Job running',
      startedAt: timestamp()
    });
    this.events.emit('job.updated', { type: 'job.updated', job });

    const setProgress = (progress: number, message: string): void => {
      job = this.jobs.update(item.jobId, {
        progress,
        message
      });
      this.events.emit('job.updated', { type: 'job.updated', job });
    };

    try {
      await item.task({ setProgress });
      job = this.jobs.update(item.jobId, {
        status: 'succeeded',
        progress: 100,
        message: 'Job completed',
        finishedAt: timestamp(),
        error: null
      });
      this.events.emit('job.updated', { type: 'job.updated', job });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown job error';
      job = this.jobs.update(item.jobId, {
        status: 'failed',
        message: 'Job failed',
        error: message,
        finishedAt: timestamp()
      });
      this.events.emit('job.updated', { type: 'job.updated', job });
    }
  }
}

export function publishJob(events: OrchestratorEvents, job: Job): void {
  events.emit('job.updated', { type: 'job.updated', job });
}
