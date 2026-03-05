<script lang="ts">
  import { onMount } from 'svelte';
  import type { Box } from '@devbox/api-client';

  import { createDevboxStore } from '$lib/devbox-store';

  export let data: { initialBoxes: Box[]; apiUrl: string };

  const store = createDevboxStore(data.initialBoxes, data.apiUrl);

  let name = '';

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
    <p>{$store.error}</p>
  {/if}

  <ul>
    {#each $store.boxes as box (box.id)}
      <li>
        <strong>{box.name}</strong>
        <span>{box.image}</span>
        <span>{box.status}</span>
        <button onclick={() => store.stop(box.id)} disabled={box.status !== 'running'}>Stop</button>
        <button onclick={() => store.remove(box.id)}>Remove</button>
      </li>
    {/each}
  </ul>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
    background: linear-gradient(165deg, #f5f7ea 0%, #dce8ef 100%);
    color: #0f1b2d;
  }

  main {
    max-width: 840px;
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

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.65rem;
  }

  li {
    display: grid;
    grid-template-columns: 1.2fr 1.2fr auto auto auto;
    gap: 0.65rem;
    align-items: center;
    background: #ffffffdd;
    border: 1px solid #153f7033;
    border-radius: 0.55rem;
    padding: 0.65rem;
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
