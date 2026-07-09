# Node.js major version baked into the image.
export NODE_MAJOR_VERSION=26

export IMAGE_NAME=rubenhak/qavor

export QAVOR_VERSION=$(yq -r ".version" ../../package.json)

# Resulting tag, e.g. "26-v1".
export IMAGE_VERSION=node${NODE_MAJOR_VERSION}-${QAVOR_VERSION}
export IMAGE_FULL_NAME=${IMAGE_NAME}:${IMAGE_VERSION}
export IMAGE_LATEST_NAME=${IMAGE_NAME}:latest
