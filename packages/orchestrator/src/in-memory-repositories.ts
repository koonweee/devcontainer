import { randomUUID } from 'node:crypto';

import type { Box, BoxFilter, Job, JobFilter } from './types.js';
import type { BoxCreate, BoxRepository, JobCreate, JobRepository } from './repositories.js';

function now(): string {
  return new Date().toISOString();
}

export class InMemoryBoxRepository implements BoxRepository {
  private readonly boxes = new Map<string, Box>();

  create(input: BoxCreate): Box {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    const box: Box = {
      id,
      name: input.name,
      image: input.image,
      status: input.status,
      containerId: input.containerId ?? null,
      networkName: input.networkName,
      volumeName: input.volumeName,
      tailnetUrl: input.tailnetUrl ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null
    };
    this.boxes.set(id, box);
    return box;
  }

  update(boxId: string, patch: Partial<Omit<Box, 'id' | 'createdAt'>>): Box {
    const current = this.get(boxId);
    if (!current) {
      throw new Error(`Box not found: ${boxId}`);
    }
    const updated: Box = {
      ...current,
      ...patch,
      updatedAt: now()
    };
    this.boxes.set(boxId, updated);
    return updated;
  }

  list(filter?: BoxFilter): Box[] {
    const includeDeleted = filter?.includeDeleted ?? false;
    return [...this.boxes.values()]
      .filter((box) => includeDeleted || !box.deletedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(boxId: string): Box | null {
    return this.boxes.get(boxId) ?? null;
  }

  getByName(name: string): Box | null {
    const box = [...this.boxes.values()].find((candidate) => candidate.name === name);
    return box ?? null;
  }
}

export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, Job>();

  create(input: JobCreate): Job {
    const id = input.id ?? randomUUID();
    const job: Job = {
      id,
      type: input.type,
      status: input.status,
      boxId: input.boxId ?? null,
      progress: input.progress ?? 0,
      message: input.message,
      error: input.error ?? null,
      createdAt: now(),
      startedAt: null,
      finishedAt: null
    };
    this.jobs.set(id, job);
    return job;
  }

  update(jobId: string, patch: Partial<Omit<Job, 'id' | 'createdAt'>>): Job {
    const current = this.get(jobId);
    if (!current) {
      throw new Error(`Job not found: ${jobId}`);
    }
    const updated: Job = {
      ...current,
      ...patch
    };
    this.jobs.set(jobId, updated);
    return updated;
  }

  list(filter?: JobFilter): Job[] {
    return [...this.jobs.values()]
      .filter((job) => !filter?.boxId || job.boxId === filter.boxId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(jobId: string): Job | null {
    return this.jobs.get(jobId) ?? null;
  }
}
