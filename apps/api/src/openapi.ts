import { writeFile } from 'node:fs/promises';
import { buildServer } from './server.js';

const app = buildServer();
await app.ready();
const doc = app.swagger();
await writeFile(new URL('../../../packages/api-client/openapi.json', import.meta.url), JSON.stringify(doc, null, 2));
await app.close();
