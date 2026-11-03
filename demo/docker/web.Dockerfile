# The playground's web service: builds the page with Vite, then runs the small server that serves it,
# signs relay tokens and forwards /relay/* to the relay. Built with the repository root as the context
# (see ../docker-compose.yml); the allow-list next to this file keeps everything else out.
#
# DEMO IMAGE. One stage, dev dependencies included (the server runs through tsx), base image by tag.

FROM node:22-bookworm-slim

RUN npm install --global pnpm@9.14.2

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches ./patches
COPY packages/contracts ./packages/contracts
COPY packages/messenger ./packages/messenger
COPY demo ./demo

# --ignore-scripts: the repository's root scripts are not wanted here.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@masia/demo..." \
 && pnpm --filter "@masia/demo" run build

ENV NODE_ENV=production
USER node
WORKDIR /app/demo
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "server/main.ts"]
