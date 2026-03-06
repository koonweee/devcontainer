import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type {
  InternalBox,
  Job,
  JobFilter,
  JobStatus,
  JobType,
  TailnetConfig,
  TailnetConfigInput
} from './types.js';

export interface BoxCreate {
  id?: string;
  name: string;
  image: string;
  status: InternalBox['status'];
  workspaceContainerId?: string | null;
  tailscaleContainerId?: string | null;
  networkName: string;
  workspaceVolumeName: string;
  tailscaleStateVolumeName: string;
  tailnetUrl?: string | null;
  tailnetDeviceId?: string | null;
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
  create(input: BoxCreate): InternalBox;
  update(boxId: string, patch: Partial<Omit<InternalBox, 'id' | 'createdAt'>>): InternalBox;
  list(): InternalBox[];
  get(boxId: string): InternalBox | null;
  getByName(name: string): InternalBox | null;
  delete(boxId: string): void;
  count(): number;
}

export interface TailnetConfigRepository {
  get(): TailnetConfig | null;
  set(input: TailnetConfigInput): TailnetConfig;
  delete(): void;
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

function mapBox(row: Record<string, unknown>): InternalBox {
  return {
    id: String(row.id),
    name: String(row.name),
    image: String(row.image),
    status: row.status as InternalBox['status'],
    workspaceContainerId: (row.workspace_container_id as string | null) ?? null,
    tailscaleContainerId: (row.tailscale_container_id as string | null) ?? null,
    networkName: String(row.network_name),
    workspaceVolumeName: String(row.workspace_volume_name),
    tailscaleStateVolumeName: String(row.tailscale_state_volume_name),
    tailnetUrl: (row.tailnet_url as string | null) ?? null,
    tailnetDeviceId: (row.tailnet_device_id as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapTailnetConfig(row: Record<string, unknown>): TailnetConfig {
  return {
    tailnet: String(row.tailnet),
    oauthClientId: String(row.oauth_client_id),
    oauthClientSecret: String(row.oauth_client_secret),
    tagsCsv: String(row.tags_csv),
    hostnamePrefix: String(row.hostname_prefix),
    authkeyExpirySeconds: Number(row.authkey_expiry_seconds),
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
  workspace_container_id TEXT,
  tailscale_container_id TEXT,
  network_name TEXT NOT NULL,
  workspace_volume_name TEXT NOT NULL,
  tailscale_state_volume_name TEXT NOT NULL,
  tailnet_url TEXT,
  tailnet_device_id TEXT,
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

const CREATE_TAILNET_CONFIG_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS tailnet_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    tailnet TEXT NOT NULL,
    oauth_client_id TEXT NOT NULL,
    oauth_client_secret TEXT NOT NULL,
    tags_csv TEXT NOT NULL DEFAULT 'tag:devcontainer',
    hostname_prefix TEXT NOT NULL DEFAULT 'devbox',
    authkey_expiry_seconds INTEGER NOT NULL DEFAULT 600,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
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

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name?: unknown }>;
  return columns.some((entry) => entry.name === column);
}

function isLegacyBoxesSchema(db: DatabaseSync): boolean {
  if (!hasBoxesTable(db)) {
    return false;
  }

  return (
    hasColumn(db, 'boxes', 'container_id') ||
    hasColumn(db, 'boxes', 'volume_name') ||
    hasColumn(db, 'boxes', 'deleted_at')
  );
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function rebuildBoxesTable(db: DatabaseSync): void {
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

  if (isLegacyBoxesSchema(db)) {
    const legacyBoxCount = countRows(db, 'boxes');
    if (legacyBoxCount > 0) {
      throw new Error(
        `Legacy box records detected (${legacyBoxCount}). Remove all existing boxes before upgrading to the sidecar runtime.`
      );
    }
    rebuildBoxesTable(db);
  } else {
    db.exec(CREATE_BOXES_TABLE_SQL);
  }

  db.exec(CREATE_NAME_UNIQUE_INDEX_SQL);
  db.exec(CREATE_TAILNET_CONFIG_TABLE_SQL);
}

/** Persists box records in SQLite with minimal query logic. */
export class SqliteBoxRepository implements BoxRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: BoxCreate): InternalBox {
    const id = input.id ?? randomUUID();
    const timestamp = nowIso();
    this.db
      .prepare(
        `
      INSERT INTO boxes (
        id,
        name,
        image,
        status,
        workspace_container_id,
        tailscale_container_id,
        network_name,
        workspace_volume_name,
        tailscale_state_volume_name,
        tailnet_url,
        tailnet_device_id,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.name,
        input.image,
        input.status,
        input.workspaceContainerId ?? null,
        input.tailscaleContainerId ?? null,
        input.networkName,
        input.workspaceVolumeName,
        input.tailscaleStateVolumeName,
        input.tailnetUrl ?? null,
        input.tailnetDeviceId ?? null,
        timestamp,
        timestamp
      );

    return this.getRequired(id);
  }

  update(boxId: string, patch: Partial<Omit<InternalBox, 'id' | 'createdAt'>>): InternalBox {
    const current = this.getRequired(boxId);
    const updated: InternalBox = {
      ...current,
      ...patch,
      updatedAt: nowIso()
    };

    this.db
      .prepare(
        `
      UPDATE boxes
      SET name = ?, image = ?, status = ?, workspace_container_id = ?, tailscale_container_id = ?, network_name = ?, workspace_volume_name = ?, tailscale_state_volume_name = ?, tailnet_url = ?, tailnet_device_id = ?, updated_at = ?
      WHERE id = ?
      `
      )
      .run(
        updated.name,
        updated.image,
        updated.status,
        updated.workspaceContainerId,
        updated.tailscaleContainerId,
        updated.networkName,
        updated.workspaceVolumeName,
        updated.tailscaleStateVolumeName,
        updated.tailnetUrl,
        updated.tailnetDeviceId,
        updated.updatedAt,
        boxId
      );

    return this.getRequired(boxId);
  }

  list(): InternalBox[] {
    const rows = this.db.prepare('SELECT * FROM boxes ORDER BY created_at DESC').all() as Record<
      string,
      unknown
    >[];
    return rows.map(mapBox);
  }

  get(boxId: string): InternalBox | null {
    const row = this.db.prepare('SELECT * FROM boxes WHERE id = ?').get(boxId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapBox(row) : null;
  }

  getByName(name: string): InternalBox | null {
    const row = this.db.prepare('SELECT * FROM boxes WHERE name = ?').get(name) as
      | Record<string, unknown>
      | undefined;
    return row ? mapBox(row) : null;
  }

  delete(boxId: string): void {
    this.db.prepare('DELETE FROM boxes WHERE id = ?').run(boxId);
  }

  count(): number {
    return countRows(this.db, 'boxes');
  }

  private getRequired(boxId: string): InternalBox {
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

/** Persists tailnet credentials in a single-row SQLite table. */
export class SqliteTailnetConfigRepository implements TailnetConfigRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(): TailnetConfig | null {
    const row = this.db.prepare('SELECT * FROM tailnet_config WHERE id = 1').get() as
      | Record<string, unknown>
      | undefined;
    return row ? mapTailnetConfig(row) : null;
  }

  set(input: TailnetConfigInput): TailnetConfig {
    const timestamp = nowIso();
    const existing = this.get();
    if (existing) {
      this.db
        .prepare(
          `UPDATE tailnet_config SET tailnet = ?, oauth_client_id = ?, oauth_client_secret = ?, tags_csv = ?, hostname_prefix = ?, authkey_expiry_seconds = ?, updated_at = ? WHERE id = 1`
        )
        .run(
          input.tailnet,
          input.oauthClientId,
          input.oauthClientSecret,
          input.tagsCsv ?? 'tag:devcontainer',
          input.hostnamePrefix ?? 'devbox',
          input.authkeyExpirySeconds ?? 600,
          timestamp
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO tailnet_config (id, tailnet, oauth_client_id, oauth_client_secret, tags_csv, hostname_prefix, authkey_expiry_seconds, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.tailnet,
          input.oauthClientId,
          input.oauthClientSecret,
          input.tagsCsv ?? 'tag:devcontainer',
          input.hostnamePrefix ?? 'devbox',
          input.authkeyExpirySeconds ?? 600,
          timestamp,
          timestamp
        );
    }
    return this.get()!;
  }

  delete(): void {
    this.db.prepare('DELETE FROM tailnet_config WHERE id = 1').run();
  }
}

export function createSqliteRepositories(dbPath: string): {
  db: DatabaseSync;
  boxes: SqliteBoxRepository;
  jobs: SqliteJobRepository;
  tailnetConfig: SqliteTailnetConfigRepository;
} {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  initializeSchema(db);
  return {
    db,
    boxes: new SqliteBoxRepository(db),
    jobs: new SqliteJobRepository(db),
    tailnetConfig: new SqliteTailnetConfigRepository(db)
  };
}
