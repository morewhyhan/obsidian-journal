ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm ci --ignore-scripts=false
COPY tsconfig*.json vite.config.ts vitest.config.ts ./
COPY apps/ apps/
COPY packages/ packages/
COPY scripts/ scripts/
COPY resources/ resources/
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates util-linux && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules/ node_modules/
COPY --from=build --chown=node:node /app/dist/ dist/
COPY --from=build --chown=node:node /app/resources/ resources/
USER node
EXPOSE 3180 3181
CMD ["node","dist/server/apps/core/main.js"]
