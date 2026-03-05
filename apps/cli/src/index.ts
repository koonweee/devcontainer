#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { createApiClient } from '@devbox/api-client';

import { buildCliProgram } from './cli.js';

const baseUrl = process.env.DEVBOX_API_URL ?? 'http://localhost:3000';
const client = createApiClient({ baseUrl });

const isEntryPoint = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isEntryPoint) {
  buildCliProgram(client)
    .parseAsync(process.argv)
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
