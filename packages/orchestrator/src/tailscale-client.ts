import type { TailnetConfig } from './types.js';

export interface TailscaleAuthKey {
  key: string;
  id: string;
}

export interface TailscaleDevice {
  id: string;
  hostname: string;
  name: string;
}

export interface TailscaleClient {
  mintAuthKey(config: TailnetConfig): Promise<TailscaleAuthKey>;
  findDeviceByHostname(config: TailnetConfig, hostname: string): Promise<TailscaleDevice | null>;
  deleteDevice(config: TailnetConfig, deviceId: string): Promise<void>;
}

async function getOAuthAccessToken(config: TailnetConfig): Promise<string> {
  const response = await fetch('https://api.tailscale.com/api/v2/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.oauthClientId,
      client_secret: config.oauthClientSecret,
      grant_type: 'client_credentials'
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tailscale OAuth token exchange failed (${response.status}): ${text}`);
  }

  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error('Tailscale OAuth response missing access_token');
  }
  return body.access_token;
}

/** Calls Tailscale control-plane API for auth key and device management. */
export class HttpTailscaleClient implements TailscaleClient {
  async mintAuthKey(config: TailnetConfig): Promise<TailscaleAuthKey> {
    const token = await getOAuthAccessToken(config);
    const tags = config.tagsCsv.split(',').map((t) => t.trim()).filter(Boolean);

    const response = await fetch(
      `https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(config.tailnet)}/keys`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          capabilities: {
            devices: {
              create: {
                reusable: false,
                ephemeral: false,
                preauthorized: true,
                tags
              }
            }
          },
          expirySeconds: config.authkeyExpirySeconds
        })
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Tailscale mint auth key failed (${response.status}): ${text}`);
    }

    const body = (await response.json()) as { key?: string; id?: string };
    if (!body.key || !body.id) {
      throw new Error('Tailscale auth key response missing key or id');
    }

    return { key: body.key, id: body.id };
  }

  private async listDevices(config: TailnetConfig): Promise<TailscaleDevice[]> {
    const token = await getOAuthAccessToken(config);

    const response = await fetch(
      `https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(config.tailnet)}/devices`,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Tailscale list devices failed (${response.status}): ${text}`);
    }

    const body = (await response.json()) as { devices?: Array<Record<string, unknown>> };
    return (body.devices ?? []).map((d) => ({
      id: String(d.id ?? ''),
      hostname: String(d.hostname ?? ''),
      name: String(d.name ?? '')
    }));
  }

  async findDeviceByHostname(
    config: TailnetConfig,
    hostname: string
  ): Promise<TailscaleDevice | null> {
    const devices = await this.listDevices(config);
    return devices.find((device) => device.hostname === hostname) ?? null;
  }

  async deleteDevice(config: TailnetConfig, deviceId: string): Promise<void> {
    const token = await getOAuthAccessToken(config);

    const response = await fetch(
      `https://api.tailscale.com/api/v2/device/${encodeURIComponent(deviceId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    if (response.status === 404) {
      return; // Idempotent: device already gone
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Tailscale delete device failed (${response.status}): ${text}`);
    }
  }
}
