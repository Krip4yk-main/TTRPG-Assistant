# Збірка з кореня репозиторію: docker build -f bot/Dockerfile .
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY bot/package.json bot/
RUN npm ci --workspace shared --workspace bot --include-workspace-root=false --ignore-scripts
COPY shared shared
COPY bot bot
RUN npm run build -w shared && npm run build -w bot

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY bot/package.json bot/
RUN npm ci --omit=dev --workspace shared --workspace bot --include-workspace-root=false --ignore-scripts
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/bot/dist bot/dist
USER node
WORKDIR /app/bot
CMD ["node", "dist/bot.js"]
