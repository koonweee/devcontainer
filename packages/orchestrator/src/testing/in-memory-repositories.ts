import { randomUUID } from 'node:crypto';

import type { InternalBox, Job, JobFilter, TailnetConfig, TailnetConfigInput } from '../types.js';
import type { BoxCreate, BoxRepository, JobCreate, JobRepository, TailnetConfigRepository } from '../repositories.js';

function now(): string {
  return new Date().toISOString();
}

/** Stores box state in memory for fast tests. */
export class InMemoryBoxRepository implements BoxRepository {
  private readonly boxes = new Map<string, InternalBox>();

  create(input: BoxCreate): InternalBox {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    const box: InternalBox = {
      id,
      name: input.name,
      image: input.image,
      status: input.status,
      containerId: input.containerId ?? null,
      networkName: input.networkName,
      volumeName: input.volumeName,
      tailnetUrl: input.tailnetUrl ?? null,
      tailnetDeviceId: input.tailnetDeviceId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.boxes.set(id, box);
    return box;
  }

  update(boxId: string, patch: Partial<Omit<InternalBox, 'id' | 'createdAt'>>): InternalBox {
    const current = this.get(boxId);
    if (!current) {
      throw new Error(`Box not found: ${boxId}`);
    }
    const updated: InternalBox = {
      ...current,
      ...patch,
      updatedAt: now()
    };
    this.boxes.set(boxId, updated);
    return updated;
  }

  list(): InternalBox[] {
    return [...this.boxes.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(boxId: string): InternalBox | null {
    return this.boxes.get(boxId) ?? null;
  }

  getByName(name: string): InternalBox | null {
    const box = [...this.boxes.values()].find((candidate) => candidate.name === name);
    return box ?? null;
  }

  delete(boxId: string): void {
    this.boxes.delete(boxId);
  }

  count(): number {
    return this.boxes.size;
  }
}

/** Stores tailnet config in memory for tests. */
export class InMemoryTailnetConfigRepository implements TailnetConfigRepository {
  private config: TailnetConfig | null = null;

  get(): TailnetConfig | null {
    return this.config;
  }

  set(input: TailnetConfigInput): TailnetConfig {
    const timestamp = now();
    this.config = {
      tailnet: input.tailnet,
      oauthClientId: input.oauthClientId,
      oauthClientSecret: input.oauthClientSecret,
      tagsCsv: input.tagsCsv ?? 'tag:devcontainer',
      hostnamePrefix: input.hostnamePrefix ?? 'devbox',
      authkeyExpirySeconds: input.authkeyExpirySeconds ?? 600,
      createdAt: this.config?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    return this.config;
  }

  delete(): void {
    this.config = null;
  }
}

/** Stores job state in memory for deterministic tests. */
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
