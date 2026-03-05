<script lang="ts">
  import { createApiClient, type TailnetConfig } from '@devbox/api-client';
  import { invalidateAll } from '$app/navigation';
  import { cn } from '$lib/utils';

  import { Button } from '$lib/components/ui/button';
  import * as Card from '$lib/components/ui/card';
  import * as Alert from '$lib/components/ui/alert';
  import { Input } from '$lib/components/ui/input';

  export let data: {
    tailnetConfig: TailnetConfig | null;
    apiUrl: string;
    tailnetConfigured: boolean;
    boxCount: number;
  };

  let editing = false;
  let saving = false;
  let error = '';
  let success = '';
  let currentTailnetConfig = data.tailnetConfig;
  let isTailnetConfigured = data.tailnetConfigured;

  // Form fields
  let formTailnet = '';
  let formClientId = '';
  let formClientSecret = '';
  const client = createApiClient({ baseUrl: data.apiUrl });

  $: locked = data.boxCount > 0 && isTailnetConfigured;

  function startEdit() {
    formTailnet = currentTailnetConfig?.tailnet ?? '';
    formClientId = currentTailnetConfig?.oauthClientId ?? '';
    formClientSecret = '';
    editing = true;
    error = '';
    success = '';
  }

  function cancelEdit() {
    editing = false;
    error = '';
  }

  async function saveConfig(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    saving = true;
    error = '';
    success = '';
    try {
      const config = await client.setTailnetConfig({
        tailnet: formTailnet,
        oauthClientId: formClientId,
        oauthClientSecret: formClientSecret
      });
      currentTailnetConfig = config;
      isTailnetConfigured = true;
      editing = false;
      success = 'Configuration saved';
      await invalidateAll();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to save';
    } finally {
      saving = false;
    }
  }

  async function clearConfig(): Promise<void> {
    saving = true;
    error = '';
    success = '';
    try {
      await client.deleteTailnetConfig();
      currentTailnetConfig = null;
      isTailnetConfigured = false;
      editing = false;
      success = 'Configuration cleared';
      await invalidateAll();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to clear';
    } finally {
      saving = false;
    }
  }

  function maskSecret(secret: string): string {
    if (secret.length <= 8) return '********';
    return secret.slice(0, 4) + '****' + secret.slice(-4);
  }
</script>

<main class="mx-auto max-w-5xl px-4 py-4">
  <h1 class="mb-4 text-base font-semibold tracking-tight">Settings</h1>

  <Card.Root class="border-border bg-card/60">
    <Card.Header>
      <Card.Title class="text-sm font-semibold">Tailscale Configuration</Card.Title>
      <Card.Description class="text-xs text-muted-foreground">
        Configure Tailscale OAuth credentials for dev box networking.
        <a
          href="https://tailscale.com/kb/1215/oauth-clients"
          target="_blank"
          rel="noopener noreferrer"
          class="text-primary hover:underline"
        >
          Get OAuth credentials
        </a>
        <div class="mt-2 space-y-1">
          <p>Tailnet value: use your Tailnet ID from Admin &rarr; Settings &rarr; General.</p>
          <p>Required scopes: <code>auth_keys</code> write and <code>devices:core</code> write.</p>
          <p>Required ACL: <code>tagOwners</code> must allow your tags (default <code>tag:devbox</code>).</p>
        </div>
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <!-- Lock banner -->
      {#if locked}
        <Alert.Root class="mb-4 border-amber-500/30 bg-amber-500/5">
          <Alert.Description class="text-sm text-amber-400">
            Configuration is locked while {data.boxCount} dev box{data.boxCount === 1 ? '' : 'es'} exist.
            Remove all boxes before editing.
          </Alert.Description>
        </Alert.Root>
      {/if}

      <!-- Success message -->
      {#if success}
        <div class="mb-4 rounded-md border border-cyan-500/30 bg-cyan-500/5 px-3 py-2 text-sm text-cyan-400">
          {success}
        </div>
      {/if}

      <!-- Error message -->
      {#if error}
        <div class="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      {/if}

      {#if !currentTailnetConfig && !editing}
        <!-- No config: show form directly -->
        <form onsubmit={saveConfig} class="space-y-3">
          <div class="grid gap-3 sm:grid-cols-3">
            <Input bind:value={formTailnet} required placeholder="tailnet (e.g. example.com)" class="h-8 bg-muted/50 font-mono text-sm" />
            <Input bind:value={formClientId} required placeholder="OAuth client ID" class="h-8 bg-muted/50 font-mono text-sm" />
            <Input bind:value={formClientSecret} required placeholder="OAuth client secret" type="password" class="h-8 bg-muted/50 font-mono text-sm" />
          </div>
          <div class="flex gap-2">
            <Button type="submit" variant="outline" size="sm" class="h-8 border-primary/40 text-primary hover:bg-primary/10 hover:text-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save configuration'}
            </Button>
          </div>
        </form>
      {:else if editing}
        <!-- Edit form -->
        <form onsubmit={saveConfig} class="space-y-3">
          <div class="grid gap-3 sm:grid-cols-3">
            <Input bind:value={formTailnet} required placeholder="tailnet (e.g. example.com)" class="h-8 bg-muted/50 font-mono text-sm" />
            <Input bind:value={formClientId} required placeholder="OAuth client ID" class="h-8 bg-muted/50 font-mono text-sm" />
            <Input bind:value={formClientSecret} required placeholder="OAuth client secret" type="password" class="h-8 bg-muted/50 font-mono text-sm" />
          </div>
          <div class="flex gap-2">
            <Button type="submit" variant="outline" size="sm" class="h-8 border-primary/40 text-primary hover:bg-primary/10 hover:text-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
            <Button type="button" variant="ghost" size="sm" class="h-8" onclick={cancelEdit} disabled={saving}>
              Cancel
            </Button>
          </div>
        </form>
      {:else if currentTailnetConfig}
        <!-- Read-only display -->
        <div class="space-y-3">
          <div class="rounded-md border border-border bg-muted/30 px-3 py-2.5">
            <div class="grid gap-2 sm:grid-cols-3">
              <div>
                <span class="text-xs text-muted-foreground">Tailnet</span>
                <p class="font-mono text-sm text-foreground">{currentTailnetConfig.tailnet}</p>
              </div>
              <div>
                <span class="text-xs text-muted-foreground">OAuth Client ID</span>
                <p class="font-mono text-sm text-foreground">{currentTailnetConfig.oauthClientId}</p>
              </div>
              <div>
                <span class="text-xs text-muted-foreground">OAuth Client Secret</span>
                <p class="font-mono text-sm text-foreground">{maskSecret(currentTailnetConfig.oauthClientSecret)}</p>
              </div>
            </div>
          </div>
          <div class="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              class="h-8"
              onclick={startEdit}
              disabled={locked}
            >
              Edit
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              class={cn('h-8', !locked && 'border-destructive/40 text-destructive hover:bg-destructive/10')}
              onclick={clearConfig}
              disabled={locked || saving}
            >
              {saving ? 'Clearing...' : 'Clear'}
            </Button>
          </div>
        </div>
      {/if}
    </Card.Content>
  </Card.Root>
</main>
