#!/usr/bin/env node
import { ApiClient } from '@devbox/api-client';

const api = new ApiClient({ baseUrl: process.env.DEVBOX_API_URL ?? 'http://localhost:3000' });
const [command, ...args] = process.argv.slice(2);

const run = async () => {
  switch (command) {
    case 'create': {
      const [name, image] = args;
      console.log(await api.post('/v1/boxes', { name, image }));
      break;
    }
    case 'ls':
      console.log(await api.get('/v1/boxes'));
      break;
    case 'stop':
      console.log(await api.post(`/v1/boxes/${args[0]}/stop`));
      break;
    case 'rm':
      console.log(await api.post(`/v1/boxes/${args[0]}`, undefined, 'DELETE'));
      break;
    case 'logs':
      for await (const event of api.sse(`/v1/boxes/${args[0]}/logs`)) console.log(event.data);
      break;
    default:
      console.log('Usage: devbox <create|ls|stop|rm|logs>');
  }
};

run();
