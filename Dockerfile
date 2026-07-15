FROM node:22-bookworm-slim AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim AS server-build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/server

COPY --from=server-build --chown=node:node /app/server/package.json /app/server/package-lock.json ./
COPY --from=server-build --chown=node:node /app/server/node_modules ./node_modules
COPY --from=server-build --chown=node:node /app/server/dist ./dist
COPY --from=server-build --chown=node:node /app/server/agents ./agents
COPY --from=web-build --chown=node:node /app/web/dist /app/web/dist

RUN mkdir -p /app/server/data /app/server/agents && chown -R node:node /app
USER node

EXPOSE 3900
VOLUME ["/app/server/data", "/app/server/agents"]
CMD ["node", "dist/index.js"]
