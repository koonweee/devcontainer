import path from 'node:path';

import { createSqliteRepositories } from './repositories.js';
import { OrchestratorEvents } from './events.js';
import { JobRunner } from './job-runner.js';
import { DockerodeRuntime } from './dockerode-runtime.js';
import { DevboxOrchestrator } from './orchestrator.js';

export interface OrchestratorFactoryOptions {
  dbPath?: string;
}

export function createOrchestrator(options?: OrchestratorFactoryOptions): DevboxOrchestrator {
  const dbPath =
    options?.dbPath ??
    process.env.DEVBOX_DB_PATH ??
    path.resolve(process.cwd(), 'devbox.sqlite');
  const repositories = createSqliteRepositories(dbPath);
  const events = new OrchestratorEvents();
  const runner = new JobRunner(repositories.jobs, events);
  const runtime = new DockerodeRuntime();
  return new DevboxOrchestrator(runtime, repositories.boxes, repositories.jobs, runner, events);
}
