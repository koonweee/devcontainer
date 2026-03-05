import { createApiClient, type TailnetConfig } from '@devbox/api-client';

export async function load() {
  const internalApiUrl = process.env.DEVBOX_INTERNAL_API_URL ?? process.env.DEVBOX_API_URL ?? 'http://localhost:3000';
  const client = createApiClient({ baseUrl: internalApiUrl });

  let tailnetConfig: TailnetConfig | null = null;
  try {
    tailnetConfig = await client.getTailnetConfig();
  } catch {
    tailnetConfig = null;
  }

  let boxCount = 0;
  try {
    const boxes = await client.listBoxes();
    boxCount = boxes.length;
  } catch {
    boxCount = 0;
  }

  return {
    tailnetConfig,
    tailnetConfigured: tailnetConfig !== null,
    boxCount
  };
}
