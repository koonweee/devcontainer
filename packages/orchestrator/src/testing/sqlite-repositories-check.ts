import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { OrchestratorEvents } from '../events.js';
import { JobRunner } from '../job-runner.js';
import { DevboxOrchestrator } from '../orchestrator.js';
import { createSqliteRepositories } from '../repositories.js';
import { MockDockerRuntime } from './mock-runtime.js';

type Mode = 'reuse' | 'migration';

async function waitForJob(
  orchestrator: DevboxOrchestrator,
  jobId: string
): Promise<'succeeded' | 'failed' | 'cancelled'> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = await orchestrator.getJob(jobId);
    if (!job) {
      throw new Error(`Job missing: ${jobId}`);
    }
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
      return job.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function runReuseCheck(): Promise<void> {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'devbox-sqlite-'));
  const dbPath = path.join(tempDir, 'devbox.sqlite');
  const repositories = createSqliteRepositories(dbPath);
  const events = new OrchestratorEvents();
  const runner = new JobRunner(repositories.jobs, events);
  const runtime = new MockDockerRuntime();
  const orchestrator = new DevboxOrchestrator(
    runtime,
    repositories.boxes,
    repositories.jobs,
    runner,
    events
  );

  try {
    const first = await orchestrator.createBox({
      name: 'sqlite-reuse'
    });
    if ((await waitForJob(orchestrator, first.job.id)) !== 'succeeded') {
      throw new Error('first create job did not succeed');
    }

    const removeJob = await orchestrator.removeBox(first.box.id);
    if ((await waitForJob(orchestrator, removeJob.id)) !== 'succeeded') {
      throw new Error('remove job did not succeed');
    }

    const second = await orchestrator.createBox({
      name: 'sqlite-reuse'
    });
    if ((await waitForJob(orchestrator, second.job.id)) !== 'succeeded') {
      throw new Error('second create job did not succeed');
    }

    if (second.box.id === first.box.id) {
      throw new Error('second box reused the original id');
    }
  } finally {
    repositories.db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runMigrationCheck(): void {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'devbox-migration-'));
  const dbPath = path.join(tempDir, 'devbox.sqlite');
  const legacyRepositories = createSqliteRepositories(dbPath);
  const timestamp = new Date().toISOString();

  legacyRepositories.db.exec('DROP INDEX IF EXISTS boxes_name_active_unique');
  legacyRepositories.db.exec('DROP TABLE IF EXISTS boxes');
  legacyRepositories.db.exec(`
    CREATE TABLE boxes (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      image TEXT NOT NULL,
      status TEXT NOT NULL,
      container_id TEXT,
      network_name TEXT NOT NULL,
      volume_name TEXT NOT NULL,
      tailnet_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
  `);

  legacyRepositories.db
    .prepare(
      `
      INSERT INTO boxes (
        id,
        name,
        image,
        status,
        container_id,
        network_name,
        volume_name,
        tailnet_url,
        created_at,
        updated_at,
        deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      'legacy-id',
      'legacy-box',
      'debian:trixie-slim',
      'stopped',
      null,
      'legacy-net',
      'legacy-vol',
      null,
      timestamp,
      timestamp,
      timestamp
    );
  legacyRepositories.db.close();

  const repositories = createSqliteRepositories(dbPath);
  try {
    const tableSqlRow = repositories.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'boxes'")
      .get() as { sql?: string } | undefined;
    const tableSql = tableSqlRow?.sql ?? '';
    if (/name\s+TEXT\s+UNIQUE/i.test(tableSql)) {
      throw new Error('legacy unique constraint still exists on boxes.name');
    }

    const indexSqlRow = repositories.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'boxes_name_active_unique'")
      .get() as { sql?: string } | undefined;
    const indexSql = indexSqlRow?.sql ?? '';
    if (!indexSql.includes('WHERE deleted_at IS NULL')) {
      throw new Error('active-only unique index was not created');
    }

    repositories.boxes.create({
      name: 'legacy-box',
      image: 'debian:trixie-slim',
      status: 'creating',
      networkName: 'legacy-net-2',
      volumeName: 'legacy-vol-2'
    });
  } finally {
    repositories.db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] as Mode | undefined;
  if (mode === 'reuse') {
    await runReuseCheck();
    console.log('ok');
    return;
  }
  if (mode === 'migration') {
    runMigrationCheck();
    console.log('ok');
    return;
  }
  throw new Error(`Unknown mode: ${mode ?? '<missing>'}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
