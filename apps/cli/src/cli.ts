import { Command } from 'commander';

import { getConfigLockedBoxCount } from '@devbox/api-client';
import type { Box, BoxLogsEvent, Job, TailnetConfig, TailnetConfigInput } from '@devbox/api-client';

export interface CliApiClient {
  createBox(input: { name: string }): Promise<{ box: Box; job: Job }>;
  listBoxes(): Promise<Box[]>;
  startBox(boxId: string): Promise<Job>;
  stopBox(boxId: string): Promise<Job>;
  removeBox(boxId: string): Promise<Job>;
  streamBoxLogs(
    boxId: string,
    options?: { follow?: boolean; since?: string; tail?: number; signal?: AbortSignal }
  ): Promise<AsyncIterable<BoxLogsEvent>>;
  getTailnetConfig(): Promise<TailnetConfig>;
  setTailnetConfig(input: TailnetConfigInput): Promise<TailnetConfig>;
  deleteTailnetConfig(): Promise<void>;
}

export function parsePositiveIntegerOption(name: string, value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  return parsed;
}

async function resolveBox(client: CliApiClient, input: string): Promise<Box> {
  const boxes = await client.listBoxes();
  const match = boxes.find((box) => box.id === input || box.name === input);
  if (!match) {
    throw new Error(`Box not found: ${input}`);
  }
  return match;
}

function exitWithConfigLockedError(boxCount: number): never {
  console.error(`Error: Cannot modify tailnet config while ${boxCount} boxes exist. Remove all boxes first.`);
  process.exit(1);
}

export function buildCliProgram(client: CliApiClient): Command {
  const program = new Command();

  program.name('devbox').description('Devbox CLI (API client only)').version('0.1.0');

  program
    .command('create')
    .description('Create a new box')
    .requiredOption('-n, --name <name>', 'box name')
    .action(async (options: { name: string }) => {
      const result = await client.createBox({ name: options.name });
      console.log(`Queued create job ${result.job.id} for box ${result.box.id}`);
    });

  program.command('ls').description('List boxes').action(async () => {
    const boxes = await client.listBoxes();
    if (boxes.length === 0) {
      console.log('No boxes found');
      return;
    }

    for (const box of boxes) {
      console.log(`${box.id}\t${box.name}\t${box.status}\t${box.image}`);
    }
  });

  program
    .command('start <box>')
    .description('Start a stopped box by id or name')
    .action(async (boxInput: string) => {
      const box = await resolveBox(client, boxInput);
      const job = await client.startBox(box.id);
      console.log(`Queued start job ${job.id} for ${box.name}`);
    });

  program
    .command('stop <box>')
    .description('Stop a box by id or name')
    .action(async (boxInput: string) => {
      const box = await resolveBox(client, boxInput);
      const job = await client.stopBox(box.id);
      console.log(`Queued stop job ${job.id} for ${box.name}`);
    });

  program
    .command('rm <box>')
    .description('Remove a box by id or name')
    .action(async (boxInput: string) => {
      const box = await resolveBox(client, boxInput);
      const job = await client.removeBox(box.id);
      console.log(`Queued remove job ${job.id} for ${box.name}`);
    });

  program
    .command('logs <box>')
    .description('Stream box logs by id or name')
    .option('-f, --follow', 'follow log output', false)
    .option('--since <iso>', 'stream logs since unix timestamp seconds or ISO datetime')
    .option('--tail <lines>', 'request only the latest number of lines', (value) =>
      parsePositiveIntegerOption('--tail', value)
    )
    .action(async (boxInput: string, options: { follow: boolean; since?: string; tail?: number }) => {
      const box = await resolveBox(client, boxInput);
      const stream = await client.streamBoxLogs(box.id, {
        follow: options.follow,
        since: options.since,
        tail: options.tail
      });

      for await (const event of stream) {
        const payload = event.data;
        console.log(`[${payload.timestamp}] ${payload.stream}: ${payload.line}`);
      }
    });

  const setup = program.command('setup').description('Manage platform setup');

  setup
    .command('tailnet')
    .description('Configure Tailscale credentials (required scopes: auth_keys write, devices:core write)')
    .requiredOption('--tailnet <tailnet>', 'Tailscale Tailnet ID (Admin > Settings > General)')
    .requiredOption('--client-id <id>', 'OAuth client ID')
    .requiredOption('--client-secret <secret>', 'OAuth client secret')
    .option('--tags <csv>', 'comma-separated tags (must be allowed by ACL tagOwners)', 'tag:devbox')
    .option('--hostname-prefix <prefix>', 'hostname prefix', 'devbox')
    .option('--authkey-expiry <seconds>', 'auth key expiry in seconds', (v) =>
      parsePositiveIntegerOption('--authkey-expiry', v)
    )
    .addHelpText(
      'after',
      [
        '',
        'Requirements:',
        '- Tailnet value: use Tailnet ID from Admin > Settings > General',
        '- OAuth scopes: auth_keys (write), devices:core (write)',
        '- ACL tagOwners must allow configured tags (default tag:devbox)',
        '- Example tagOwners: {"tagOwners":{"tag:devbox":["autogroup:admin","tag:devbox"]}}'
      ].join('\n')
    )
    .action(async (options: {
      tailnet: string;
      clientId: string;
      clientSecret: string;
      tags: string;
      hostnamePrefix: string;
      authkeyExpiry?: number;
    }) => {
      try {
        const config = await client.setTailnetConfig({
          tailnet: options.tailnet,
          oauthClientId: options.clientId,
          oauthClientSecret: options.clientSecret,
          tagsCsv: options.tags,
          hostnamePrefix: options.hostnamePrefix,
          authkeyExpirySeconds: options.authkeyExpiry
        });
        console.log(`Tailnet configured: ${config.tailnet} (prefix: ${config.hostnamePrefix})`);
      } catch (err) {
        const boxCount = getConfigLockedBoxCount(err);
        if (boxCount !== null) {
          exitWithConfigLockedError(boxCount);
        }
        throw err;
      }
    });

  setup
    .command('status')
    .description('Show current setup status')
    .action(async () => {
      try {
        const config = await client.getTailnetConfig();
        console.log(`Tailnet: ${config.tailnet}`);
        console.log(`OAuth client: ${config.oauthClientId}`);
        console.log(`Tags: ${config.tagsCsv}`);
        console.log(`Hostname prefix: ${config.hostnamePrefix}`);
        console.log(`Auth key expiry: ${config.authkeyExpirySeconds}s`);
      } catch {
        console.log('Tailnet: not configured');
      }
    });

  setup
    .command('clear')
    .description('Clear tailnet configuration')
    .action(async () => {
      try {
        await client.deleteTailnetConfig();
        console.log('Tailnet configuration cleared');
      } catch (err) {
        const boxCount = getConfigLockedBoxCount(err);
        if (boxCount !== null) {
          exitWithConfigLockedError(boxCount);
        }
        throw err;
      }
    });

  return program;
}
