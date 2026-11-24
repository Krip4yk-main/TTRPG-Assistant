# Збірка з кореня репозиторію: docker build -f backend/Dockerfile .
# Міграції — окремий крок (не при старті):
#   docker run --rm --env-file backend/.env <image> npm run db:migrate
# Бекенд виконується через tsx (окремого кроку компіляції немає), shared збирається в dist.
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
RUN npm ci --workspace shared --workspace backend --include-workspace-root=false --ignore-scripts
COPY shared shared
COPY backend backend
RUN npm run build -w shared && npm run typecheck -w backend

FROM node:26-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
RUN npm ci --omit=dev --workspace shared --workspace backend --include-workspace-root=false --ignore-scripts
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/backend/src backend/src
COPY backend/tsconfig.json backend/
COPY tsconfig.base.json ./
USER node
WORKDIR /app/backend
EXPOSE 3000
CMD ["npm", "start"]
