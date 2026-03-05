#!/usr/bin/env node
import { Command } from 'commander';

import { createApiClient, type Box } from '@devbox/api-client';

const baseUrl = process.env.DEVBOX_API_URL ?? 'http://localhost:3000';
const client = createApiClient({ baseUrl });

async function resolveBox(input: string): Promise<Box> {
  const boxes = await client.listBoxes();
  const match = boxes.find((box) => box.id === input || box.name === input);
  if (!match) {
    throw new Error(`Box not found: ${input}`);
  }
  return match;
}

const program = new Command();

program.name('devbox').description('Devbox CLI (API client only)').version('0.1.0');

program
  .command('create')
  .description('Create a new box')
  .requiredOption('-n, --name <name>', 'box name')
  .option('-i, --image <image>', 'container image', 'debian:trixie-slim')
  .action(async (options: { name: string; image: string }) => {
    const result = await client.createBox({ name: options.name, image: options.image });
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
  .command('stop <box>')
  .description('Stop a box by id or name')
  .action(async (boxInput: string) => {
    const box = await resolveBox(boxInput);
    const job = await client.stopBox(box.id);
    console.log(`Queued stop job ${job.id} for ${box.name}`);
  });

program
  .command('rm <box>')
  .description('Remove a box by id or name')
  .action(async (boxInput: string) => {
    const box = await resolveBox(boxInput);
    const job = await client.removeBox(box.id);
    console.log(`Queued remove job ${job.id} for ${box.name}`);
  });

program
  .command('logs <box>')
  .description('Stream box logs by id or name')
  .option('-f, --follow', 'follow log output', false)
  .action(async (boxInput: string, options: { follow: boolean }) => {
    const box = await resolveBox(boxInput);
    const stream = await client.streamBoxLogs(box.id, { follow: options.follow });

    for await (const event of stream) {
      if (event.event !== 'box.logs') {
        continue;
      }
      const payload = event.data as { timestamp?: string; stream?: string; line?: string };
      console.log(`[${payload.timestamp}] ${payload.stream}: ${payload.line}`);
    }
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
