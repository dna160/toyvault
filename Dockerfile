# toyvault-api on Railway: builds shared, the API and the read-only viewer; runs migrations on start.
FROM node:22-slim
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/connector/package.json packages/connector/
COPY packages/viewer/package.json packages/viewer/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY packages/api packages/api
COPY packages/viewer packages/viewer
RUN pnpm --filter @toyvault/shared --filter @toyvault/api --filter @toyvault/viewer build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "packages/api/dist/index.js"]
