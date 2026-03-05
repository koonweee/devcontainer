import { InMemoryBoxRepository, InMemoryJobRepository, MockDockerRuntime } from '@devbox/orchestrator/testing';
import { JobRunner } from '@devbox/orchestrator/job-runner';
import { DevboxOrchestrator } from '@devbox/orchestrator/orchestrator';
import { OrchestratorEvents } from '@devbox/orchestrator/events';

export function buildInMemoryOrchestrator(): DevboxOrchestrator {
  const events = new OrchestratorEvents();
  const jobs = new InMemoryJobRepository();
  const boxes = new InMemoryBoxRepository();
  const runner = new JobRunner(jobs, events);
  const runtime = new MockDockerRuntime();
  return new DevboxOrchestrator(runtime, boxes, jobs, runner, events);
}
