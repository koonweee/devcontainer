#!/usr/bin/env sh
set -eu

IMAGE_TAG="${1:-devbox-runtime:local}"

docker build -t "${IMAGE_TAG}" -f Dockerfile .
echo "Built runtime image: ${IMAGE_TAG}"
