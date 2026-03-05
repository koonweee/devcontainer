import { buildApp } from './app.js';

const host = '0.0.0.0';
const port = 3000;

const app = await buildApp();
await app.listen({ host, port });
