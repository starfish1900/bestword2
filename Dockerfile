# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app

# Keep the dependency layer reusable while installing the Linux native packages.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/lexicon/package.json packages/lexicon/package.json
COPY packages/ai/package.json packages/ai/package.json
RUN npm ci --include=dev

COPY tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LEXICON_PATH=data/lexicon.bin.gz
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/package.json ./apps/web/package.json
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/engine/package.json ./packages/engine/package.json
COPY --from=build --chown=node:node /app/packages/engine/dist ./packages/engine/dist
COPY --from=build --chown=node:node /app/packages/lexicon/package.json ./packages/lexicon/package.json
COPY --from=build --chown=node:node /app/packages/lexicon/dist ./packages/lexicon/dist
COPY --from=build --chown=node:node /app/packages/ai/package.json ./packages/ai/package.json
COPY --from=build --chown=node:node /app/packages/ai/dist ./packages/ai/dist
COPY --chown=node:node data/lexicon.bin.gz data/lexicon-manifest.json ./data/
COPY --chown=node:node data/easy.gaddag data/medium.gaddag ./data/

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
# The worker overrides this command. Both roles receive signals directly.
CMD ["node", "apps/server/dist/index.js"]
