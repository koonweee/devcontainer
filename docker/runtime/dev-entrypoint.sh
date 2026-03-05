#!/bin/sh
set -eu

DEV_USER="${DEV_USER:-dev}"

if [ -z "${DEV_PASSWORD:-}" ]; then
  echo "error: DEV_PASSWORD is required" >&2
  exit 1
fi

if ! id "${DEV_USER}" >/dev/null 2>&1; then
  echo "error: user '${DEV_USER}' does not exist" >&2
  exit 1
fi

echo "${DEV_USER}:${DEV_PASSWORD}" | chpasswd

mkdir -p /var/run/sshd

# --- Tailscale setup ---
DEVBOX_TAILSCALE_STATE_DIR="${DEVBOX_TAILSCALE_STATE_DIR:-/var/lib/tailscale}"
TAILSCALE_STATE_FILE="${DEVBOX_TAILSCALE_STATE_DIR}/tailscaled.state"
mkdir -p "${DEVBOX_TAILSCALE_STATE_DIR}"

tailscaled --state="${TAILSCALE_STATE_FILE}" \
  --socket=/var/run/tailscale/tailscaled.sock &
TAILSCALED_PID=$!

# Wait for tailscaled socket
for i in 1 2 3 4 5 6 7 8 9 10; do
  [ -S /var/run/tailscale/tailscaled.sock ] && break
  sleep 0.5
done

if [ -s "${TAILSCALE_STATE_FILE}" ]; then
  # Restart: reconnect using persisted state
  tailscale up --ssh
elif [ -n "${DEVBOX_TAILSCALE_AUTHKEY:-}" ]; then
  # First boot: authenticate with authkey
  tailscale up --authkey="${DEVBOX_TAILSCALE_AUTHKEY}" \
    --hostname="${DEVBOX_TAILSCALE_HOSTNAME:-devbox}" \
    --ssh
else
  # Fallback path when no authkey is provided
  tailscale up --ssh
fi

# --- Firewall: restrict inbound to Tailnet only ---
iptables -F INPUT 2>/dev/null || true
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -i tailscale0 -j ACCEPT
iptables -A INPUT -j DROP

# Best-effort tailscaled shutdown
cleanup() {
  kill "$TAILSCALED_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

exec /usr/sbin/sshd -D -e
