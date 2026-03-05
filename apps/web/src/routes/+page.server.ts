import { createApiClient } from '@devbox/api-client';

export async function load() {
  const internalApiUrl = process.env.DEVBOX_INTERNAL_API_URL ?? process.env.DEVBOX_API_URL ?? 'http://localhost:3000';
  const client = createApiClient({ baseUrl: internalApiUrl });

  try {
    const initialBoxes = await client.listBoxes();
    return { initialBoxes };
  } catch {
    return { initialBoxes: [] };
  }
}
