import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import { createSqliteRepositories } from './repositories.js';
import { OrchestratorEvents } from './events.js';
import { JobRunner } from './job-runner.js';
import { DockerodeRuntime } from './dockerode-runtime.js';
import { DevboxOrchestrator } from './orchestrator.js';
import { HttpTailscaleClient } from './tailscale-client.js';

export interface OrchestratorFactoryOptions {
  dbPath?: string;
  runtimeImage?: string;
  runtimeEnv?: Record<string, string>;
  runtimeEnvFile?: string;
}

function stripOptionalQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseRuntimeEnvFile(runtimeEnvFile: string): Record<string, string> {
  const runtimeEnv: Record<string, string> = {};

  if (!existsSync(runtimeEnvFile)) {
    return runtimeEnv;
  }

  const source = readFileSync(runtimeEnvFile, 'utf8');
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const normalized = line.startsWith('export ') ? line.slice('export '.length) : line;
    const equalsIndex = normalized.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, equalsIndex).trim();
    const value = stripOptionalQuotes(normalized.slice(equalsIndex + 1).trim());
    if (!key) {
      continue;
    }
    runtimeEnv[key] = value;
  }

  return runtimeEnv;
}

function resolveRuntimeEnv(runtimeEnvFile: string): Record<string, string> {
  return parseRuntimeEnvFile(runtimeEnvFile);
}

export function createOrchestrator(options?: OrchestratorFactoryOptions): DevboxOrchestrator {
  const dbPath =
    options?.dbPath ??
    process.env.DEVBOX_DB_PATH ??
    path.resolve(process.cwd(), 'devbox.sqlite');
  const runtimeImage =
    options?.runtimeImage ??
    process.env.DEVBOX_RUNTIME_IMAGE ??
    'devbox-runtime:local';
  const runtimeEnvFile =
    options?.runtimeEnvFile ??
    process.env.DEVBOX_RUNTIME_ENV_FILE ??
    (existsSync(path.resolve(process.cwd(), 'docker/runtime/runtime.env'))
      ? path.resolve(process.cwd(), 'docker/runtime/runtime.env')
      : path.resolve(process.cwd(), '../../docker/runtime/runtime.env'));
  const runtimeEnv = options?.runtimeEnv ?? resolveRuntimeEnv(runtimeEnvFile);
  const repositories = createSqliteRepositories(dbPath);
  const events = new OrchestratorEvents();
  const runner = new JobRunner(repositories.jobs, events);
  const runtime = new DockerodeRuntime();
  const tailscaleClient = new HttpTailscaleClient();
  return new DevboxOrchestrator(
    runtime,
    repositories.boxes,
    repositories.jobs,
    runner,
    events,
    runtimeImage,
    runtimeEnv,
    repositories.tailnetConfig,
    tailscaleClient
  );
}
