import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type { Box, Job, JobFilter, JobStatus, JobType } from './types.js';

export interface BoxCreate {
  id?: string;
  name: string;
  image: string;
  status: Box['status'];
  containerId?: string | null;
  networkName: string;
  volumeName: string;
  tailnetUrl?: string | null;
}

export interface JobCreate {
  id?: string;
  type: JobType;
  status: JobStatus;
  boxId?: string | null;
  progress?: number;
  message: string;
  error?: string | null;
}

export interface BoxRepository {
  create(input: BoxCreate): Box;
  update(boxId: string, patch: Partial<Omit<Box, 'id' | 'createdAt'>>): Box;
  list(): Box[];
  get(boxId: string): Box | null;
  getByName(name: string): Box | null;
  delete(boxId: string): void;
}

export interface JobRepository {
  create(input: JobCreate): Job;
  update(jobId: string, patch: Partial<Omit<Job, 'id' | 'createdAt'>>): Job;
  list(filter?: JobFilter): Job[];
  get(jobId: string): Job | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapBox(row: Record<string, unknown>): Box {
  return {
    id: String(row.id),
    name: String(row.name),
    image: String(row.image),
    status: row.status as Box['status'],
    containerId: (row.container_id as string | null) ?? null,
    networkName: String(row.network_name),
    volumeName: String(row.volume_name),
    tailnetUrl: (row.tailnet_url as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapJob(row: Record<string, unknown>): Job {
  return {
    id: String(row.id),
    type: row.type as Job['type'],
    status: row.status as Job['status'],
    boxId: (row.box_id as string | null) ?? null,
    progress: Number(row.progress),
    message: String(row.message),
    error: (row.error as string | null) ?? null,
    createdAt: String(row.created_at),
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null
  };
}

const BOXES_COLUMNS_SQL = `
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  image TEXT NOT NULL,
  status TEXT NOT NULL,
  container_id TEXT,
  network_name TEXT NOT NULL,
  volume_name TEXT NOT NULL,
  tailnet_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
`;

const CREATE_BOXES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS boxes (
    ${BOXES_COLUMNS_SQL}
  );
`;

const CREATE_JOBS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    box_id TEXT,
    progress INTEGER NOT NULL,
    message TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
`;

const CREATE_NAME_UNIQUE_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS boxes_name_unique
  ON boxes(name);
`;

function hasBoxesTable(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'boxes'")
    .get() as { 1?: number } | undefined;
  return row !== undefined;
}

function hasDeletedAtColumn(db: DatabaseSync): boolean {
  if (!hasBoxesTable(db)) {
    return false;
  }

  const columns = db.prepare("PRAGMA table_info('boxes')").all() as Array<{ name?: unknown }>;
  return columns.some((column) => column.name === 'deleted_at');
}

function resetBoxesTableForHardDeletes(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    db.exec('DROP TABLE IF EXISTS boxes');
    db.exec(CREATE_BOXES_TABLE_SQL);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function initializeSchema(db: DatabaseSync): void {
  db.exec(CREATE_JOBS_TABLE_SQL);

  if (hasDeletedAtColumn(db)) {
    resetBoxesTableForHardDeletes(db);
  } else {
    db.exec(CREATE_BOXES_TABLE_SQL);
  }

  db.exec(CREATE_NAME_UNIQUE_INDEX_SQL);
}

/** Persists box records in SQLite with minimal query logic. */
export class SqliteBoxRepository implements BoxRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: BoxCreate): Box {
    const id = input.id ?? randomUUID();
    const timestamp = nowIso();
    this.db
      .prepare(
        `
      INSERT INTO boxes (id, name, image, status, container_id, network_name, volume_name, tailnet_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.name,
        input.image,
        input.status,
        input.containerId ?? null,
        input.networkName,
        input.volumeName,
        input.tailnetUrl ?? null,
        timestamp,
        timestamp
      );

    return this.getRequired(id);
  }

  update(boxId: string, patch: Partial<Omit<Box, 'id' | 'createdAt'>>): Box {
    const current = this.getRequired(boxId);
    const updated: Box = {
      ...current,
      ...patch,
      updatedAt: nowIso()
    };

    this.db
      .prepare(
        `
      UPDATE boxes
      SET name = ?, image = ?, status = ?, container_id = ?, network_name = ?, volume_name = ?, tailnet_url = ?, updated_at = ?
      WHERE id = ?
      `
      )
      .run(
        updated.name,
        updated.image,
        updated.status,
        updated.containerId,
        updated.networkName,
        updated.volumeName,
        updated.tailnetUrl,
        updated.updatedAt,
        boxId
      );

    return this.getRequired(boxId);
  }

  list(): Box[] {
    const rows = this.db.prepare('SELECT * FROM boxes ORDER BY created_at DESC').all() as Record<
      string,
      unknown
    >[];
    return rows.map(mapBox);
  }

  get(boxId: string): Box | null {
    const row = this.db.prepare('SELECT * FROM boxes WHERE id = ?').get(boxId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapBox(row) : null;
  }

  getByName(name: string): Box | null {
    const row = this.db.prepare('SELECT * FROM boxes WHERE name = ?').get(name) as
      | Record<string, unknown>
      | undefined;
    return row ? mapBox(row) : null;
  }

  delete(boxId: string): void {
    this.db.prepare('DELETE FROM boxes WHERE id = ?').run(boxId);
  }

  private getRequired(boxId: string): Box {
    const box = this.get(boxId);
    if (!box) {
      throw new Error(`Box not found: ${boxId}`);
    }
    return box;
  }
}

/** Persists job records in SQLite for queue and status tracking. */
export class SqliteJobRepository implements JobRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: JobCreate): Job {
    const id = input.id ?? randomUUID();
    const timestamp = nowIso();
    this.db
      .prepare(
        `
      INSERT INTO jobs (id, type, status, box_id, progress, message, error, created_at, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `
      )
      .run(
        id,
        input.type,
        input.status,
        input.boxId ?? null,
        input.progress ?? 0,
        input.message,
        input.error ?? null,
        timestamp
      );

    return this.getRequired(id);
  }

  update(jobId: string, patch: Partial<Omit<Job, 'id' | 'createdAt'>>): Job {
    const current = this.getRequired(jobId);
    const updated: Job = {
      ...current,
      ...patch
    };

    this.db
      .prepare(
        `
      UPDATE jobs
      SET type = ?, status = ?, box_id = ?, progress = ?, message = ?, error = ?, started_at = ?, finished_at = ?
      WHERE id = ?
      `
      )
      .run(
        updated.type,
        updated.status,
        updated.boxId,
        updated.progress,
        updated.message,
        updated.error,
        updated.startedAt,
        updated.finishedAt,
        jobId
      );

    return this.getRequired(jobId);
  }

  list(filter?: JobFilter): Job[] {
    if (filter?.boxId) {
      const rows = this.db
        .prepare('SELECT * FROM jobs WHERE box_id = ? ORDER BY created_at DESC')
        .all(filter.boxId) as Record<string, unknown>[];
      return rows.map(mapJob);
    }

    const rows = this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all() as Record<
      string,
      unknown
    >[];
    return rows.map(mapJob);
  }

  get(jobId: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapJob(row) : null;
  }

  private getRequired(jobId: string): Job {
    const job = this.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }
    return job;
  }
}

export function createSqliteRepositories(dbPath: string): {
  db: DatabaseSync;
  boxes: SqliteBoxRepository;
  jobs: SqliteJobRepository;
} {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  initializeSchema(db);
  return {
    db,
    boxes: new SqliteBoxRepository(db),
    jobs: new SqliteJobRepository(db)
  };
}
