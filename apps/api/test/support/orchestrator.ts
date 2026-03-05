import { InMemoryBoxRepository, InMemoryJobRepository, InMemoryTailnetConfigRepository, MockDockerRuntime } from '@devbox/orchestrator/testing';
import { MockTailscaleClient } from '@devbox/orchestrator/testing';
import { JobRunner } from '@devbox/orchestrator/job-runner';
import { DevboxOrchestrator } from '@devbox/orchestrator/orchestrator';
import { OrchestratorEvents } from '@devbox/orchestrator/events';

export function buildInMemoryHarness(): {
  events: OrchestratorEvents;
  jobs: InMemoryJobRepository;
  boxes: InMemoryBoxRepository;
  tailnetConfig: InMemoryTailnetConfigRepository;
  runner: JobRunner;
  runtime: MockDockerRuntime;
  tailscaleClient: MockTailscaleClient;
  orchestrator: DevboxOrchestrator;
} {
  const events = new OrchestratorEvents();
  const jobs = new InMemoryJobRepository();
  const boxes = new InMemoryBoxRepository();
  const tailnetConfig = new InMemoryTailnetConfigRepository();
  const runner = new JobRunner(jobs, events);
  const runtime = new MockDockerRuntime();
  const tailscaleClient = new MockTailscaleClient();

  // Pre-configure tailnet so box creation works in tests
  tailnetConfig.set({
    tailnet: 'test.example.com',
    oauthClientId: 'test-client',
    oauthClientSecret: 'test-secret'
  });

  const orchestrator = new DevboxOrchestrator(
    runtime, boxes, jobs, runner, events,
    undefined, undefined,
    tailnetConfig, tailscaleClient
  );
  return { events, jobs, boxes, tailnetConfig, runner, runtime, tailscaleClient, orchestrator };
}

export function buildInMemoryOrchestrator(): DevboxOrchestrator {
  return buildInMemoryHarness().orchestrator;
}
