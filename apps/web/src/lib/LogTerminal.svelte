<script lang="ts">
  import { onMount } from 'svelte';
  import { Terminal } from '@xterm/xterm';

  import type { LogLine } from '$lib/devbox-store';

  export let lines: LogLine[] = [];
  export let scrollback = 1_000;

  let host: HTMLDivElement;
  let terminal: Terminal | null = null;
  let renderedLines = 0;

  function formatLine(line: LogLine): string {
    return `[${line.timestamp}] ${line.stream}: ${line.line}`;
  }

  function syncTerminal(): void {
    if (!terminal) {
      return;
    }

    if (lines.length < renderedLines) {
      terminal.reset();
      renderedLines = 0;
    }

    if (lines.length === renderedLines) {
      return;
    }

    const pending = lines.slice(renderedLines);
    if (pending.length > 0) {
      terminal.write(`${pending.map(formatLine).join('\r\n')}\r\n`);
      renderedLines = lines.length;
    }
  }

  $: {
    syncTerminal();
  }

  onMount(() => {
    terminal = new Terminal({
      convertEol: true,
      scrollback,
      cursorBlink: false,
      fontSize: 12,
      fontFamily: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
      theme: {
        background: '#09121f',
        foreground: '#d4dfef'
      }
    });
    terminal.open(host);
    syncTerminal();

    return () => {
      terminal?.dispose();
      terminal = null;
      renderedLines = 0;
    };
  });
</script>

<div class="terminal" bind:this={host}></div>

<style>
  .terminal {
    width: 100%;
    min-height: 320px;
    border-radius: 0.6rem;
    border: 1px solid #2d4f6150;
    overflow: hidden;
  }
</style>
