export type BoxStatus =
  | 'creating'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'removing'
  | 'error';

export type JobType = 'create' | 'stop' | 'remove' | 'sync' | 'cleanup';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Box {
  id: string;
  name: string;
  image: string;
  status: BoxStatus;
  containerId: string | null;
  networkName: string;
  volumeName: string;
  tailnetUrl: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  boxId: string | null;
  progress: number;
  message: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CreateBoxInput {
  name: string;
  image: string;
  command?: string[];
  env?: Record<string, string>;
}

export interface BoxFilter {
  includeDeleted?: boolean;
}

export interface JobFilter {
  boxId?: string;
}

export interface LogEvent {
  boxId: string;
  stream: 'stdout' | 'stderr';
  line: string;
  timestamp: string;
}

export interface LogOptions {
  follow?: boolean;
  since?: string;
}

export interface OrchestratorEventMap {
  'job.updated': { type: 'job.updated'; job: Job };
  'box.updated': { type: 'box.updated'; box: Box };
  'box.logs': { type: 'box.logs'; boxId: string; log: LogEvent };
}

export interface CreateBoxResult {
  box: Box;
  job: Job;
}
