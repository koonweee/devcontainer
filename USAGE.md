# Setting up

1. Install dependencies: `pnpm install`.
2. Start API locally: `pnpm --filter @devbox/api openapi && pnpm --filter @devbox/api build` (or run with your preferred TS runner).
3. Set `DEVBOX_API_URL` for web/CLI if not using `http://localhost:3000`.
4. Use `pnpm gen:client` whenever API route schemas change.

# User flows

1. Create a box from CLI: `devbox create <name> <image:tag>`.
2. List boxes: `devbox ls`.
3. Stop/remove a box: `devbox stop <boxId>` and `devbox rm <boxId>`.
4. Follow logs: `devbox logs <boxId>`.
5. In web UI, open the boxes page to view current status sourced from the API.
