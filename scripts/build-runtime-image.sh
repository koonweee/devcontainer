#!/usr/bin/env sh
set -eu

RUNTIME_TAG="${1:-devbox-runtime:local}"

docker build -t "${RUNTIME_TAG}" -f docker/runtime/Dockerfile docker/runtime
echo "Built runtime image: ${RUNTIME_TAG}"
