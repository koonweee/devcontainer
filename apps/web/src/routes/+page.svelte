<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';

  let boxes: Array<{ id: string; name: string; status: string }> = [];

  onMount(async () => {
    boxes = await api.get('/v1/boxes');
  });
</script>

<h1>Dev Boxes</h1>
<ul>
  {#each boxes as box}
    <li>{box.name} — {box.status}</li>
  {/each}
</ul>
