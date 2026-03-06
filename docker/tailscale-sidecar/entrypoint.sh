#!/bin/sh
set -eu

TAILSCALE_STATE_DIR="${DEVBOX_TAILSCALE_STATE_DIR:-/var/lib/tailscale}"
TAILSCALE_STATE_FILE="${TAILSCALE_STATE_DIR}/tailscaled.state"
TAILSCALE_SOCKET="/var/run/tailscale/tailscaled.sock"
mkdir -p "${TAILSCALE_STATE_DIR}" /var/run/tailscale

if [ -z "${DEVBOX_TAILSCALE_AUTHKEY:-}" ] && [ ! -s "${TAILSCALE_STATE_FILE}" ]; then
  echo "error: Tailscale auth requires DEVBOX_TAILSCALE_AUTHKEY or persisted state at ${TAILSCALE_STATE_FILE}" >&2
  exit 1
fi

tailscaled --state="${TAILSCALE_STATE_FILE}" --socket="${TAILSCALE_SOCKET}" &
TAILSCALED_PID=$!

for i in 1 2 3 4 5 6 7 8 9 10; do
  [ -S "${TAILSCALE_SOCKET}" ] && break
  sleep 0.5
done

if [ ! -S "${TAILSCALE_SOCKET}" ]; then
  echo "error: tailscaled socket did not become ready" >&2
  exit 1
fi

if [ -n "${DEVBOX_TAILSCALE_AUTHKEY:-}" ] && ! grep -q '"_profiles"' "${TAILSCALE_STATE_FILE}" 2>/dev/null; then
  tailscale up --authkey="${DEVBOX_TAILSCALE_AUTHKEY}" \
    --hostname="${DEVBOX_TAILSCALE_HOSTNAME:-devbox}" \
    --ssh
else
  tailscale up --hostname="${DEVBOX_TAILSCALE_HOSTNAME:-devbox}" --ssh
fi

iptables -F INPUT 2>/dev/null || true
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -i tailscale0 -j ACCEPT
iptables -A INPUT -j DROP

trap 'kill "$TAILSCALED_PID" 2>/dev/null || true; wait "$TAILSCALED_PID" 2>/dev/null || true' EXIT INT TERM
wait "$TAILSCALED_PID"
