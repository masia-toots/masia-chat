# The relay for the playground: the open relay server (apps/relay) and the two workspace packages it
# runs from, installed from the repository's own lockfile. Built with the repository root as the context
# (see ../docker-compose.yml); the allow-list next to this file keeps everything else out.
#
# DEMO IMAGE. It runs the TypeScript sources through tsx, as the relay's `start` script does, and the
# base image is a tag, not a digest. Neither is a decision about a production image.

FROM node:22-bookworm-slim

# openssl: the Prisma schema engine needs it. pnpm: the lockfile is pnpm's.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global pnpm@9.14.2

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches ./patches
COPY packages/contracts ./packages/contracts
COPY packages/relay ./packages/relay
COPY apps/relay ./apps/relay
COPY demo/docker ./demo/docker

# --ignore-scripts: the repository's root scripts (and Prisma's postinstall) are not wanted here. The
# Prisma engines are fetched explicitly on the next line instead, so a failed download fails the build.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@masia/relay-server..." \
 && cd apps/relay \
 && node_modules/.bin/prisma --version

USER node
EXPOSE 3400
CMD ["node", "/app/demo/docker/relay-entry.mjs"]
