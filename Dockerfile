# Builds the single binary, then ships it on a base that has the Docker CLI, since
# Maestro creates sibling containers on the host daemon.
FROM oven/bun:1 AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10
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
