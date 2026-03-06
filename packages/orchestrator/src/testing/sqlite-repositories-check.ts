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

type Mode = 'reuse' | 'schema';

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

function runSchemaCheck(): void {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'devbox-schema-'));
  const dbPath = path.join(tempDir, 'devbox.sqlite');
  const repositories = createSqliteRepositories(dbPath);

  try {
    const tableSqlRow = repositories.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'boxes'")
      .get() as { sql?: string } | undefined;
    const tableSql = tableSqlRow?.sql ?? '';
    if (!tableSql.includes('container_id TEXT')) {
      throw new Error('expected single-container schema to include container_id');
    }
    if (!tableSql.includes('volume_name TEXT')) {
      throw new Error('expected single-container schema to include volume_name');
    }
    if (tableSql.includes('workspace_container_id') || tableSql.includes('tailscale_container_id')) {
      throw new Error('grouped runtime schema should not exist');
    }
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
  if (mode === 'schema') {
    runSchemaCheck();
    console.log('ok');
    return;
  }
  throw new Error(`Unknown mode: ${mode ?? '<missing>'}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
