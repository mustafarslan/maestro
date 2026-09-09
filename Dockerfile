# Builds the single binary, then ships it on a base that has the Docker CLI, since
# Maestro creates sibling containers on the host daemon.
FROM oven/bun:1 AS build
WORKDIR /src

# The bun image ships Debian's node, which is 20 — the workspace requires >=22.14, and
# pnpm only warns about that before failing later in less obvious ways.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# corepack takes the version from package.json's `packageManager`. Installing pnpm
# globally alongside that is the same conflict that kept CI red for every run.
RUN corepack enable

# pnpm refuses to remove a node_modules directory it did not create when there is no
# TTY, which is every image build. .dockerignore keeps the host's tree out; CI=true is
# the belt to that braces.
ENV CI=true
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run build:ui && pnpm exec tsc -b
RUN bun build --compile --outfile /out/maestro apps/cli/dist/index.js

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git docker.io \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/maestro /usr/local/bin/maestro
ENV MAESTRO_HOME=/data
VOLUME ["/data"]
ENTRYPOINT ["maestro"]
CMD ["serve"]
