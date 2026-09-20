FROM node:22.23.2-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.26.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22.23.2-bookworm-slim AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.26.2 --activate
COPY --from=build /app /app
RUN mkdir -p /data/documents && chown -R node:node /data
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
