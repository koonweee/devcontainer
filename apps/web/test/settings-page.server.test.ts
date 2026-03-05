import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTailnetConfig = vi.fn();
const listBoxes = vi.fn();

vi.mock('@devbox/api-client', () => ({
  createApiClient: () => ({
    getTailnetConfig,
    listBoxes
  })
}));

import { load } from '../src/routes/settings/+page.server.js';

describe('settings page server load', () => {
  beforeEach(() => {
    getTailnetConfig.mockReset();
    listBoxes.mockReset();
  });

  it('returns current boxCount and configured state from API', async () => {
    getTailnetConfig.mockResolvedValue({
      tailnet: 'example.com',
      oauthClientId: 'client-id',
      oauthClientSecret: 'secret',
      tagsCsv: 'tag:devcontainer'
    });
    listBoxes.mockResolvedValue([
      { id: 'box-1' },
      { id: 'box-2' }
    ]);

    const data = await load();

    expect(data.tailnetConfigured).toBe(true);
    expect(data.boxCount).toBe(2);
    expect(data.tailnetConfig).toMatchObject({ tailnet: 'example.com' });
  });

  it('falls back safely when config or box list fetch fails', async () => {
    getTailnetConfig.mockRejectedValue(new Error('missing'));
    listBoxes.mockRejectedValue(new Error('boom'));

    const data = await load();

    expect(data.tailnetConfigured).toBe(false);
    expect(data.boxCount).toBe(0);
    expect(data.tailnetConfig).toBeNull();
  });
});
