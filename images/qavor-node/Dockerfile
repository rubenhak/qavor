FROM node:26.3.0-alpine3.24

RUN node --version
RUN npm --version

RUN apk update && apk upgrade && \
    apk --no-cache add g++ gcc libgcc libstdc++ linux-headers make bash git openssh yq

RUN npm install -g pnpm

RUN pnpm --version

RUN npm install node-gyp -g

RUN npm install mocha -g

RUN npm install typescript -g

# qavor CLI — installed from npm, pinned to the released version.
# QAVOR_VERSION is passed at build time (see images/qavor-node/configuration.sh
# and the docker job in .github/workflows/publish.yml); defaults to latest.
ARG QAVOR_VERSION=latest
RUN npm install -g qavor@${QAVOR_VERSION}
RUN qavor --version

# kind (Kubernetes IN Docker) — arch-detected binary
ARG KIND_VERSION=v0.29.0
RUN ARCH="$(uname -m)" && \
    case "$ARCH" in \
      x86_64) KIND_ARCH=amd64 ;; \
      aarch64) KIND_ARCH=arm64 ;; \
      *) echo "unsupported arch: $ARCH" && exit 1 ;; \
    esac && \
    wget -qO /usr/local/bin/kind "https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-linux-${KIND_ARCH}" && \
    chmod +x /usr/local/bin/kind

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
