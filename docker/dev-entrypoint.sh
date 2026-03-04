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

exec /usr/sbin/sshd -D -e
