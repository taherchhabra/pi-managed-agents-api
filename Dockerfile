FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY ui ./ui
COPY examples ./examples
COPY docs/desktop.md ./docs/desktop.md
RUN npm run build
RUN npm prune --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS api
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 ARTIFACT_DIR=/data/artifacts
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY deploy/health.mjs ./deploy/health.mjs
RUN mkdir -p /data/artifacts && chown -R node:node /data
USER node
EXPOSE 8080
CMD ["node", "dist/src/main.js"]

FROM docker:29-cli AS docker-cli
FROM api AS worker
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
ENV ROLE=worker
