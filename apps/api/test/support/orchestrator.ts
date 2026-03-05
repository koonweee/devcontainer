import { InMemoryBoxRepository, InMemoryJobRepository, MockDockerRuntime } from '@devbox/orchestrator/testing';
import { JobRunner } from '@devbox/orchestrator/job-runner';
import { DevboxOrchestrator } from '@devbox/orchestrator/orchestrator';
import { OrchestratorEvents } from '@devbox/orchestrator/events';

export function buildInMemoryHarness(): {
  events: OrchestratorEvents;
  jobs: InMemoryJobRepository;
  boxes: InMemoryBoxRepository;
  runner: JobRunner;
  runtime: MockDockerRuntime;
  orchestrator: DevboxOrchestrator;
} {
  const events = new OrchestratorEvents();
  const jobs = new InMemoryJobRepository();
  const boxes = new InMemoryBoxRepository();
  const runner = new JobRunner(jobs, events);
  const runtime = new MockDockerRuntime();
  const orchestrator = new DevboxOrchestrator(runtime, boxes, jobs, runner, events);
  return { events, jobs, boxes, runner, runtime, orchestrator };
}

export function buildInMemoryOrchestrator(): DevboxOrchestrator {
  return buildInMemoryHarness().orchestrator;
}
