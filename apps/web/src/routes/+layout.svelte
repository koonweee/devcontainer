<script>
  import '../app.css';
  import { page } from '$app/stores';
  import { cn } from '$lib/utils';
  import * as Tooltip from '$lib/components/ui/tooltip';
</script>

<Tooltip.Provider>
<div class="min-h-screen">
  <nav class="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur-md">
    <div class="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
      <div class="flex items-center gap-3">
        <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15">
          <svg class="h-4 w-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="6" width="20" height="12" rx="2" />
            <path d="M12 12h.01" />
            <path d="M17 12h.01" />
            <path d="M7 12h.01" />
          </svg>
        </div>
        <span class="text-base font-semibold tracking-tight">devcontainer</span>
      </div>

      <div class="flex items-center gap-1">
        <a
          href="/"
          class={cn(
            'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            $page.url.pathname === '/'
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          Dev Boxes
        </a>
        <a
          href="/settings"
          class={cn(
            'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            $page.url.pathname === '/settings'
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          Settings
        </a>
      </div>
    </div>
  </nav>

  <slot />
</div>
</Tooltip.Provider>
