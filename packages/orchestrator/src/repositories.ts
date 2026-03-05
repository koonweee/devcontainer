import type { Box, BoxRepository, Job, JobRepository } from './types.js';

const now = () => new Date().toISOString();

export class InMemoryBoxRepository implements BoxRepository {
  private readonly boxes = new Map<string, Box>();

  async create(data: Omit<Box, 'createdAt' | 'updatedAt' | 'deletedAt'>): Promise<Box> {
    const box: Box = { ...data, createdAt: now(), updatedAt: now(), deletedAt: null };
    this.boxes.set(box.id, box);
    return box;
  }

  async update(id: string, updates: Partial<Box>): Promise<Box> {
    const current = this.boxes.get(id);
    if (!current) throw new Error(`box ${id} not found`);
    const next = { ...current, ...updates, updatedAt: now() };
    this.boxes.set(id, next);
    return next;
  }

  async getById(id: string): Promise<Box | null> { return this.boxes.get(id) ?? null; }
  async list(): Promise<Box[]> { return [...this.boxes.values()]; }
}

export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, Job>();

  async create(data: Omit<Job, 'createdAt' | 'startedAt' | 'finishedAt'>): Promise<Job> {
    const job: Job = { ...data, createdAt: now(), startedAt: null, finishedAt: null };
    this.jobs.set(job.id, job);
    return job;
  }

  async update(id: string, updates: Partial<Job>): Promise<Job> {
    const current = this.jobs.get(id);
    if (!current) throw new Error(`job ${id} not found`);
    const next = { ...current, ...updates };
    this.jobs.set(id, next);
    return next;
  }

  async getById(id: string): Promise<Job | null> { return this.jobs.get(id) ?? null; }
  async list(): Promise<Job[]> { return [...this.jobs.values()]; }
}
