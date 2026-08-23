FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ingestion/package.json packages/ingestion/package.json
COPY packages/broadcast/package.json packages/broadcast/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/ingestion/tsconfig*.json packages/ingestion/
COPY packages/broadcast/tsconfig*.json packages/broadcast/
COPY packages/shared/src packages/shared/src
COPY packages/ingestion/src packages/ingestion/src
COPY packages/broadcast/src packages/broadcast/src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ingestion/package.json packages/ingestion/package.json
COPY packages/broadcast/package.json packages/broadcast/package.json
RUN npm ci --omit=dev
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/ingestion/dist packages/ingestion/dist
COPY --from=build /app/packages/broadcast/dist packages/broadcast/dist

# Overridden per-service in docker-compose.yml (ingestion vs. broadcast).
CMD ["node", "packages/broadcast/dist/index.js"]
