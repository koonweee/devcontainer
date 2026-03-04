# Tailnet-only SSH devcontainer

This stack runs a Debian Trixie dev container behind a Tailscale sidecar.

## What you get

- Base image: `debian:trixie-slim`
- Tools: `vim`, `tmux`, `mosh`, `zsh`
- Minimal Node/TS deps: `git`, `curl`, `ca-certificates`, `openssh-server`, `sudo`, `ripgrep`, `less`, `procps`, `iproute2`, `xz-utils`, `unzip`
- Node.js: major `22` (NodeSource)
- Non-root `dev` user with passwordless sudo
- SSH password auth enabled, key auth disabled
- Persistent workspace volume mounted at `/workspace`
- Tailnet-only ingress firewall in the shared namespace

## Setup

1. Create env file:

```bash
cp .env.example .env
```

2. Update `.env` with your values:

- `TS_AUTHKEY`: your Tailscale auth key
- `TS_HOSTNAME`: hostname to register on your tailnet
- `DEV_PASSWORD`: SSH password for user `dev`
- Optional: `DEV_USER`, `DEV_UID`, `DEV_GID`

3. Start:

```bash
docker compose up -d --build
```

4. Check Tailscale status:

```bash
docker compose logs -f tailscale
```

5. SSH in over tailnet:

```bash
ssh dev@<TS_HOSTNAME>
```

## Network behavior

- `devcontainer` shares `tailscale` service network namespace.
- Inbound traffic is restricted via iptables rules to:
  - `tailscale0` traffic
  - `lo`
  - established/related connections
  - UDP `41641` on `eth0` for direct Tailscale peer traffic
- No host ports are published in Compose.

## Port access from tailnet

If you run a service in the dev container on `0.0.0.0`, it is reachable from tailnet peers on the same Tailscale hostname.

Example:

```bash
node -e "require('http').createServer((_,res)=>res.end('ok')).listen(3000,'0.0.0.0')"
```

Then from another tailnet device:

```bash
curl http://<TS_HOSTNAME>:3000
```

## Persistence

- Workspace data is stored in named volume `workspace-data` at `/workspace`.
- Tailscale state is stored in named volume `tailscale-state`.
