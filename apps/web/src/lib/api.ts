import { ApiClient } from '@devbox/api-client';

export const api = new ApiClient({ baseUrl: process.env.DEVBOX_API_URL ?? 'http://localhost:3000' });
