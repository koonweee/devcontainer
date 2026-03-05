import { createApiClient } from '@devbox/api-client';

export async function load() {
  const internalApiUrl = process.env.DEVBOX_INTERNAL_API_URL ?? process.env.DEVBOX_API_URL ?? 'http://localhost:3000';
  const publicApiUrl = process.env.DEVBOX_PUBLIC_API_URL ?? 'http://localhost:3000';
  const client = createApiClient({ baseUrl: internalApiUrl });

  let tailnetConfigured = false;
  try {
    await client.getTailnetConfig();
    tailnetConfigured = true;
  } catch {
    tailnetConfigured = false;
  }

  let boxCount = 0;
  try {
    const boxes = await client.listBoxes();
    boxCount = boxes.length;
  } catch {
    boxCount = 0;
  }

  return { apiUrl: publicApiUrl, tailnetConfigured, boxCount };
}
