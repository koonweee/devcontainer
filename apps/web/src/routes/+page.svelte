<script lang="ts">
  import { onMount } from 'svelte';
  import type { Box } from '@devbox/api-client';
  import '@xterm/xterm/css/xterm.css';

  import LogTerminal from '$lib/LogTerminal.svelte';
  import { createDevboxStore } from '$lib/devbox-store';

  export let data: { initialBoxes: Box[]; apiUrl: string };

  const store = createDevboxStore(data.initialBoxes, data.apiUrl);

  let name = '';

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
</script>

<main>
  <h1>Dev Boxes</h1>

  <form onsubmit={createBox}>
    <label>
      Name
      <input bind:value={name} minlength="3" maxlength="63" required placeholder="my-devbox" />
    </label>

    <button type="submit">Create</button>
  </form>

  {#if $store.error}
    <p class="global-error">{$store.error}</p>
  {/if}

  <ul>
    {#each $store.boxes as box (box.id)}
      <li>
        <strong>{box.name}</strong>
        <span>{box.image}</span>
        <span>{box.status}</span>
        {#if box.status === 'running'}
          <button onclick={() => store.stop(box.id)}>Stop</button>
        {:else if box.status === 'stopped'}
          <button onclick={() => store.start(box.id)}>Start</button>
        {:else}
          <span></span>
        {/if}
        <button onclick={() => store.remove(box.id)}>Remove</button>
        <button onclick={() => store.openLogs(box.id)}>View logs</button>
      </li>
    {/each}
  </ul>

  {#if $store.openLogTabs.length > 0}
    <section class="logs">
      <div class="tabs" role="tablist" aria-label="Log tabs">
        {#each $store.openLogTabs as tabId (tabId)}
          <div class="tab">
            <button
              class="tab-button"
              class:active={$store.activeLogTab === tabId}
              onclick={() => store.setActiveLogTab(tabId)}
              role="tab"
              aria-selected={$store.activeLogTab === tabId}
              type="button"
            >
              {boxLabel(tabId)}
            </button>
            <button class="tab-close" onclick={() => store.closeLogs(tabId)} type="button">Close</button>
          </div>
        {/each}
      </div>

      {#if activeViewer}
        <div class="log-controls">
          <label class="follow-toggle">
            <input
              type="checkbox"
              checked={activeViewer.follow}
              onchange={(event) =>
                store.setLogFollow(activeViewer.boxId, (event.currentTarget as HTMLInputElement).checked)}
            />
            Follow
          </label>
          <button type="button" onclick={() => store.clearLogs(activeViewer.boxId)}>Clear</button>
          <span class="status">Status: {activeViewer.status}</span>
          {#if activeViewer.error}
            <span class="log-error">{activeViewer.error}</span>
          {/if}
        </div>

        <LogTerminal lines={activeViewer.lines} />
      {/if}
    </section>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
    background: linear-gradient(165deg, #f5f7ea 0%, #dce8ef 100%);
    color: #0f1b2d;
  }

  main {
    max-width: 980px;
    margin: 0 auto;
    padding: 2rem 1rem 3rem;
  }

  h1 {
    margin: 0 0 1rem;
    font-size: 2rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  form {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.8rem;
    align-items: end;
    margin-bottom: 1.25rem;
    background: #ffffffcc;
    border: 1px solid #1f3b4d33;
    padding: 0.85rem;
    border-radius: 0.6rem;
  }

  label {
    display: grid;
    gap: 0.35rem;
    font-size: 0.9rem;
  }

  input {
    border: 1px solid #2d4f6150;
    border-radius: 0.5rem;
    padding: 0.55rem 0.65rem;
    font-size: 0.95rem;
  }

  button {
    border: none;
    border-radius: 0.45rem;
    padding: 0.55rem 0.9rem;
    font-weight: 600;
    cursor: pointer;
    background: #153f70;
    color: white;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .global-error,
  .log-error {
    color: #8d1f1f;
    font-weight: 600;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.65rem;
  }

  li {
    display: grid;
    grid-template-columns: 1.1fr 1.2fr auto auto auto auto;
    gap: 0.65rem;
    align-items: center;
    background: #ffffffdd;
    border: 1px solid #153f7033;
    border-radius: 0.55rem;
    padding: 0.65rem;
  }

  .logs {
    margin-top: 1.25rem;
    background: #ffffffdd;
    border: 1px solid #153f7033;
    border-radius: 0.55rem;
    padding: 0.75rem;
    display: grid;
    gap: 0.75rem;
  }

  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .tab {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: #eaf1f7;
    border: 1px solid #153f7033;
    border-radius: 0.45rem;
    padding: 0.2rem;
  }

  .tab-button {
    background: transparent;
    color: #123254;
    padding: 0.4rem 0.7rem;
  }

  .tab-button.active {
    background: #153f70;
    color: #fff;
  }

  .tab-close {
    background: #c24343;
    padding: 0.35rem 0.6rem;
  }

  .log-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.65rem;
    align-items: center;
  }

  .follow-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .follow-toggle input {
    width: auto;
    margin: 0;
    padding: 0;
  }

  .status {
    color: #1f3b4d;
    font-size: 0.9rem;
    font-weight: 600;
  }

  @media (max-width: 760px) {
    form {
      grid-template-columns: 1fr;
    }

    li {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
