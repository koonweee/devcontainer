export type BoxStatus = 'creating' | 'running' | 'stopping' | 'stopped' | 'removing' | 'error';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type JobType = 'create' | 'stop' | 'remove' | 'sync' | 'cleanup';

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

export interface LogEvent {
  timestamp: string;
  line: string;
}

export interface CreateBoxInput {
  name: string;
  image: string;
}

export interface DockerRuntime {
  createManagedResources(input: { boxId: string; name: string; image: string; labels: Record<string, string> }): Promise<{ containerId: string }>;
  stopManagedContainer(boxId: string): Promise<void>;
  removeManagedResources(boxId: string): Promise<void>;
  streamLogs(boxId: string): AsyncIterable<LogEvent>;
}

export interface BoxRepository {
  create(data: Omit<Box, 'createdAt' | 'updatedAt' | 'deletedAt'>): Promise<Box>;
  update(id: string, updates: Partial<Box>): Promise<Box>;
  getById(id: string): Promise<Box | null>;
  list(): Promise<Box[]>;
}

export interface JobRepository {
  create(data: Omit<Job, 'createdAt' | 'startedAt' | 'finishedAt'>): Promise<Job>;
  update(id: string, updates: Partial<Job>): Promise<Job>;
  getById(id: string): Promise<Job | null>;
  list(): Promise<Job[]>;
}
