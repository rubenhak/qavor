#!/bin/bash
MY_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
MY_DIR="$(dirname $MY_PATH)"
cd ${MY_DIR}

source configuration.sh

echo "Building and Pushing: ${IMAGE_FULL_NAME}"

docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --tag ${IMAGE_FULL_NAME} \
    --tag ${IMAGE_LATEST_NAME} \
    --build-arg QAVOR_VERSION=${QAVOR_VERSION} \
    --progress plain \
    --push \
    .