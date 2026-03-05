<script lang="ts">
  import { onMount } from 'svelte';
  import type { Box } from '@devbox/api-client';
  import '@xterm/xterm/css/xterm.css';

  import LogTerminal from '$lib/LogTerminal.svelte';
  import { createDevboxStore } from '$lib/devbox-store';
  import { cn } from '$lib/utils';

  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import * as Card from '$lib/components/ui/card';
  import * as Alert from '$lib/components/ui/alert';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import { Input } from '$lib/components/ui/input';
  import { Separator } from '$lib/components/ui/separator';

  export let data: { initialBoxes: Box[]; apiUrl: string; tailnetConfigured: boolean };

  const store = createDevboxStore(data.initialBoxes, data.apiUrl);

  let name = '';
  let confirmRemoveId: string | null = null;

  $: activeViewer = $store.activeLogTab ? $store.logViewers[$store.activeLogTab] : null;

  onMount(() => {
    let disconnect: (() => void) | undefined;
    store.connectEvents().then((stopEvents) => {
      disconnect = stopEvents;
    });

    return () => {
      disconnect?.();
    };
  });

  async function createBox(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await store.create(name);
    name = '';
  }

  function boxLabel(boxId: string): string {
    const box = $store.boxes.find((item) => item.id === boxId);
    return box?.name ?? boxId;
  }

  function statusVariant(status: Box['status']): string {
    switch (status) {
      case 'running':
        return 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30';
      case 'stopped':
        return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30';
      case 'creating':
      case 'starting':
      case 'stopping':
      case 'removing':
        return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
      case 'error':
        return 'bg-red-500/15 text-red-400 border-red-500/30';
      default:
        return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30';
    }
  }

  function truncateImage(image: string): string {
    if (image.length <= 40) return image;
    return image.slice(0, 37) + '...';
  }

  function handleRemove(boxId: string): void {
    confirmRemoveId = boxId;
  }

  async function confirmRemove(): Promise<void> {
    if (confirmRemoveId) {
      await store.remove(confirmRemoveId);
      confirmRemoveId = null;
    }
  }
</script>

<main class="mx-auto max-w-5xl px-4 py-4">
  <!-- Sub-header: title + count + create form -->
  <div class="mb-4 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <h1 class="text-base font-semibold tracking-tight">Dev Boxes</h1>
      {#if $store.boxes.length > 0}
        <span class="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{$store.boxes.length}</span>
      {/if}
    </div>

    <form onsubmit={createBox} class="flex items-center gap-2">
      <Input
        bind:value={name}
        minlength={3}
        maxlength={63}
        required
        placeholder="box-name"
        disabled={!data.tailnetConfigured}
        class="h-8 w-44 bg-muted/50 font-mono text-sm placeholder:text-muted-foreground/50"
      />
      {#if data.tailnetConfigured}
        <Button type="submit" variant="outline" size="sm" class="h-8 border-primary/40 text-primary hover:bg-primary/10 hover:text-primary">
          Create
        </Button>
      {:else}
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <span {...props} class="inline-flex h-8 cursor-not-allowed items-center rounded-md border border-primary/40 bg-background px-3 text-sm font-medium text-muted-foreground opacity-50">
                Create
              </span>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content>
              Configure Tailscale in <a href="/settings" class="underline">Settings</a> first
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      {/if}
    </form>
  </div>

  <!-- Error Alert -->
  {#if $store.error}
    <Alert.Root variant="destructive" class="mb-4 border-destructive/30 bg-destructive/10">
      <Alert.Description class="flex items-center justify-between text-sm">
        <span>{$store.error}</span>
        <button
          class="ml-4 text-xs text-destructive/70 hover:text-destructive"
          onclick={() => { /* error will clear on next successful action */ }}
        >
          Dismiss
        </button>
      </Alert.Description>
    </Alert.Root>
  {/if}

  <!-- Box List -->
  {#if $store.boxes.length === 0}
    <div class="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
      <div class="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
        <svg class="h-6 w-6 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <path d="M12 12h.01" />
        </svg>
      </div>
      <p class="text-sm text-muted-foreground">No dev boxes yet</p>
      <p class="mt-1 text-xs text-muted-foreground/60">Create one using the form above</p>
    </div>
  {:else}
    <div class="space-y-1.5">
      {#each $store.boxes as box (box.id)}
        <Card.Root class="border-border bg-card/60 transition-colors hover:bg-card/80">
          <div class="flex items-center gap-3 px-4 py-2.5">
            <!-- Status dot -->
            <div class={cn(
              'h-2 w-2 shrink-0 rounded-full',
              box.status === 'running' ? 'bg-cyan-400 shadow-[0_0_6px_theme(--color-primary)]' :
              box.status === 'error' ? 'bg-red-400' :
              ['creating', 'starting', 'stopping', 'removing'].includes(box.status) ? 'bg-amber-400 animate-pulse' :
              'bg-zinc-500'
            )}></div>

            <!-- Name -->
            <span class="min-w-0 flex-shrink-0 truncate font-mono text-sm font-medium text-foreground">
              {box.name}
            </span>

            <!-- Tailnet URL -->
            {#if box.tailnetUrl}
              <span class="min-w-0 truncate font-mono text-xs text-cyan-400/80" title={box.tailnetUrl}>
                {box.tailnetUrl}
              </span>
            {:else}
              <!-- Image -->
              <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={box.image}>
                {truncateImage(box.image)}
              </span>
            {/if}

            <!-- Status Badge -->
            <Badge variant="outline" class={cn('shrink-0 border px-2 py-0 text-[0.65rem] font-medium uppercase tracking-wider', statusVariant(box.status))}>
              {box.status}
            </Badge>

            <!-- Actions -->
            <div class="flex shrink-0 items-center gap-1">
              {#if box.status === 'running'}
                <Button variant="ghost" size="icon-sm" onclick={() => store.stop(box.id)} class="h-7 w-7 text-muted-foreground hover:text-foreground" title="Stop">
                  <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
                </Button>
              {:else if box.status === 'stopped'}
                <Button variant="ghost" size="icon-sm" onclick={() => store.start(box.id)} class="h-7 w-7 text-muted-foreground hover:text-primary" title="Start">
                  <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7z" /></svg>
                </Button>
              {:else}
                <div class="h-7 w-7"></div>
              {/if}

              <Button variant="ghost" size="icon-sm" onclick={() => store.openLogs(box.id)} class="h-7 w-7 text-muted-foreground hover:text-foreground" title="View logs">
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M13 4v16" /><path d="M17 4v16" /><path d="M19 4H9.5a4.5 4.5 0 0 0 0 9H13" />
                </svg>
              </Button>

              <Button
                variant="ghost"
                size="icon-sm"
                onclick={() => handleRemove(box.id)}
                class="h-7 w-7 text-muted-foreground hover:text-destructive"
                title="Remove"
                disabled={['creating', 'removing'].includes(box.status)}
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </svg>
              </Button>
            </div>
          </div>
        </Card.Root>
      {/each}
    </div>
  {/if}

  <!-- Log Viewer -->
  {#if $store.openLogTabs.length > 0}
    <Separator class="my-4 bg-border" />

    <Card.Root class="overflow-hidden border-border bg-card/60">
      <!-- Tab bar -->
      <div class="flex items-center gap-0.5 overflow-x-auto border-b border-border bg-muted/30 px-2 pt-1.5">
        {#each $store.openLogTabs as tabId (tabId)}
          <div class={cn(
            'group relative flex items-center rounded-t-md text-xs font-medium transition-colors',
            $store.activeLogTab === tabId
              ? 'bg-card text-foreground'
              : 'text-muted-foreground hover:text-foreground/80'
          )}>
            {#if $store.activeLogTab === tabId}
              <div class="absolute inset-x-0 bottom-0 h-px bg-primary"></div>
            {/if}
            <button
              class="px-3 py-1.5 font-mono"
              onclick={() => store.setActiveLogTab(tabId)}
              type="button"
            >
              {boxLabel(tabId)}
            </button>
            <button
              class="mr-1 rounded p-0.5 text-muted-foreground/50 hover:bg-muted hover:text-foreground"
              onclick={() => store.closeLogs(tabId)}
              type="button"
              title="Close tab"
            >
              <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
        {/each}
      </div>

      <!-- Log controls + terminal -->
      {#if activeViewer}
        <div class="flex items-center gap-3 border-b border-border px-3 py-1.5">
          <label class="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={activeViewer.follow}
              onchange={(event) =>
                store.setLogFollow(activeViewer.boxId, (event.currentTarget as HTMLInputElement).checked)}
              class="accent-primary"
            />
            Follow
          </label>
          <Button variant="ghost" size="sm" onclick={() => store.clearLogs(activeViewer.boxId)} class="h-6 px-2 text-xs text-muted-foreground hover:text-foreground">
            Clear
          </Button>

          <div class="flex-1"></div>

          <div class="flex items-center gap-1.5">
            <div class={cn(
              'h-1.5 w-1.5 rounded-full',
              activeViewer.status === 'streaming' ? 'bg-cyan-400 animate-pulse' :
              activeViewer.status === 'connecting' ? 'bg-amber-400 animate-pulse' :
              activeViewer.status === 'error' ? 'bg-red-400' :
              'bg-zinc-500'
            )}></div>
            <span class="font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">{activeViewer.status}</span>
          </div>

          {#if activeViewer.error}
            <span class="text-xs text-destructive">{activeViewer.error}</span>
          {/if}
        </div>

        <div class="p-2">
          <LogTerminal lines={activeViewer.lines} />
        </div>
      {/if}
    </Card.Root>
  {/if}
</main>

<!-- Remove confirmation dialog -->
<Dialog.Root open={confirmRemoveId !== null} onOpenChange={(open) => { if (!open) confirmRemoveId = null; }}>
  <Dialog.Content class="border-border bg-card sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Remove dev box</Dialog.Title>
      <Dialog.Description class="text-muted-foreground">
        This will permanently destroy the container and its network. This action cannot be undone.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer class="gap-2 sm:gap-0">
      <Button variant="ghost" onclick={() => { confirmRemoveId = null; }}>Cancel</Button>
      <Button variant="destructive" onclick={confirmRemove}>Remove</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
