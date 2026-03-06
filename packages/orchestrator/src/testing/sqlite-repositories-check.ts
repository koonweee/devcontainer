import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { OrchestratorEvents } from '../events.js';
import { JobRunner } from '../job-runner.js';
import { DevboxOrchestrator } from '../orchestrator.js';
import { createSqliteRepositories } from '../repositories.js';
import { MockDockerRuntime } from './mock-runtime.js';
import { InMemoryTailnetConfigRepository } from './in-memory-repositories.js';
import { MockTailscaleClient } from './mock-tailscale-client.js';

type Mode = 'reuse' | 'migration-empty' | 'migration-gate';

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
  const tailnetConfig = new InMemoryTailnetConfigRepository();
  tailnetConfig.set({
    tailnet: 'example.com',
    oauthClientId: 'client-id',
    oauthClientSecret: 'client-secret'
  });
  const tailscaleClient = new MockTailscaleClient();
  const orchestrator = new DevboxOrchestrator(
    runtime,
    repositories.boxes,
    repositories.jobs,
    runner,
    events,
    undefined,
    {},
    tailnetConfig,
    tailscaleClient,
    undefined,
    [1, 1, 1]
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

function writeLegacyBoxesTable(dbPath: string, withRow: boolean): void {
  const repositories = createSqliteRepositories(dbPath);
  const timestamp = new Date().toISOString();

  repositories.db.exec('DROP INDEX IF EXISTS boxes_name_unique');
  repositories.db.exec('DROP TABLE IF EXISTS boxes');
  repositories.db.exec(`
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

  if (withRow) {
    repositories.db
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
  }

  repositories.db.close();
}

function runEmptyMigrationCheck(): void {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'devbox-migration-empty-'));
  const dbPath = path.join(tempDir, 'devbox.sqlite');
  writeLegacyBoxesTable(dbPath, false);

  const repositories = createSqliteRepositories(dbPath);
  try {
    const tableSqlRow = repositories.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'boxes'")
      .get() as { sql?: string } | undefined;
    const tableSql = tableSqlRow?.sql ?? '';
    if (tableSql.includes('deleted_at')) {
      throw new Error('legacy deleted_at column still exists after reset');
    }

    repositories.boxes.create({
      name: 'legacy-box',
      image: 'debian:trixie-slim',
      status: 'creating',
      networkName: 'legacy-net-2',
      workspaceVolumeName: 'legacy-workspace-vol-2',
      tailscaleStateVolumeName: 'legacy-tsstate-vol-2'
    });

    let duplicateAllowed = false;
    try {
      repositories.boxes.create({
        name: 'legacy-box',
        image: 'debian:trixie-slim',
        status: 'creating',
        networkName: 'legacy-net-3',
        workspaceVolumeName: 'legacy-workspace-vol-3',
        tailscaleStateVolumeName: 'legacy-tsstate-vol-3'
      });
      duplicateAllowed = true;
    } catch {
      // Expected.
    }
    if (duplicateAllowed) {
      throw new Error('global name uniqueness did not reject duplicate name');
    }
  } finally {
    repositories.db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runMigrationGateCheck(): void {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'devbox-migration-gate-'));
  const dbPath = path.join(tempDir, 'devbox.sqlite');
  writeLegacyBoxesTable(dbPath, true);

  try {
    createSqliteRepositories(dbPath);
    throw new Error('expected legacy box gate to fail startup');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Legacy box records detected')) {
      throw error;
    }
  } finally {
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
  if (mode === 'migration-empty') {
    runEmptyMigrationCheck();
    console.log('ok');
    return;
  }
  if (mode === 'migration-gate') {
    runMigrationGateCheck();
    console.log('ok');
    return;
  }
  throw new Error(`Unknown mode: ${mode ?? '<missing>'}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
