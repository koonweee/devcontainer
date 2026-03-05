<script lang="ts">
  import { onMount } from 'svelte';
  import type { Terminal } from '@xterm/xterm';

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

  $: if (terminal) {
    lines;
    syncTerminal();
  }

  onMount(async () => {
    const { Terminal } = await import('@xterm/xterm');
    terminal = new Terminal({
      convertEol: true,
      scrollback,
      cursorBlink: false,
      fontSize: 12,
      fontFamily: '"JetBrains Mono", "IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
      theme: {
        background: '#0a0a10',
        foreground: '#d4dfef',
        cursor: '#22d3ee',
        selectionBackground: '#22d3ee33'
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

<div class="min-h-[320px] w-full overflow-hidden rounded-lg border border-border bg-[#0a0a10]" bind:this={host}></div>
