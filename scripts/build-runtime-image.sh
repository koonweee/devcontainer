#!/usr/bin/env sh
set -eu

RUNTIME_TAG="${1:-devbox-runtime:local}"
SIDECAR_TAG="${2:-devbox-tailscale-sidecar:local}"

docker build -t "${RUNTIME_TAG}" -f docker/runtime/Dockerfile docker/runtime
docker build -t "${SIDECAR_TAG}" -f docker/tailscale-sidecar/Dockerfile docker/tailscale-sidecar
echo "Built runtime image: ${RUNTIME_TAG}"
echo "Built tailscale sidecar image: ${SIDECAR_TAG}"
