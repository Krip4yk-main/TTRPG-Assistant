# Збірка з кореня репозиторію: docker build -f frontend/Dockerfile .
# У збірці лише середовище (NG_APP_DEPLOY_ENV, NG_APP_DEV_LOGIN); ім'я Telegram-бота й способи входу
# фронтенд бере під час запуску з GET /api/public-config.
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY frontend/package.json frontend/
RUN npm ci --workspace shared --workspace frontend --include-workspace-root=false --ignore-scripts
COPY shared shared
COPY frontend frontend
ARG NG_APP_DEV_LOGIN="false"
ARG NG_APP_DEPLOY_ENV="prod"
ENV NG_APP_DEV_LOGIN=${NG_APP_DEV_LOGIN} \
    NG_APP_DEPLOY_ENV=${NG_APP_DEPLOY_ENV}
RUN npm run build -w shared && npm run build -w frontend

# Статика за nginx; /api і /socket.io проксіює зовнішній reverse proxy на бекенд.
FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime
COPY frontend/nginx-security-headers.conf /etc/nginx/snippets/security-headers.conf
# Шаблон обробляє entrypoint nginx-образу (envsubst за змінною DEPLOY_ENV).
ENV DEPLOY_ENV=prod
COPY frontend/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/frontend/dist/frontend/browser /usr/share/nginx/html
EXPOSE 8080
