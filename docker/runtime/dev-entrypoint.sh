#!/bin/sh
set -eu

DEV_USER="${DEV_USER:-dev}"

if ! id "${DEV_USER}" >/dev/null 2>&1; then
  echo "error: user '${DEV_USER}' does not exist" >&2
  exit 1
fi

mkdir -p /var/run/sshd

exec /usr/sbin/sshd -D -e
