#!/bin/bash
MY_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
MY_DIR="$(dirname $MY_PATH)"
cd ${MY_DIR}

source configuration.sh

docker push ${IMAGE_FULL_NAME}

docker tag ${IMAGE_FULL_NAME} ${IMAGE_LATEST_NAME}
docker push ${IMAGE_LATEST_NAME}
