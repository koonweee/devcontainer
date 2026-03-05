import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildApp, buildInMemoryOrchestrator } from './app.js';

const app = await buildApp({ orchestrator: buildInMemoryOrchestrator() });
await app.ready();

const outputPath = path.resolve(process.cwd(), 'openapi/openapi.json');
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(app.swagger(), null, 2));

await app.close();
console.log(`OpenAPI written to ${outputPath}`);
