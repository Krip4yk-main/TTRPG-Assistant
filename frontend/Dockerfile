# Збірка з кореня репозиторію: docker build -f frontend/Dockerfile .
# Налаштування фронтенду — на етапі збірки (не секрети), див. frontend/.env.template:
#   docker build -f frontend/Dockerfile --build-arg NG_APP_TELEGRAM_BOT_USERNAME=my_bot .
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY frontend/package.json frontend/
RUN npm ci --workspace shared --workspace frontend --include-workspace-root=false --ignore-scripts
COPY shared shared
COPY frontend frontend
ARG NG_APP_TELEGRAM_BOT_USERNAME=""
ARG NG_APP_GOOGLE_LOGIN=""
ARG NG_APP_DEV_LOGIN="false"
ENV NG_APP_TELEGRAM_BOT_USERNAME=${NG_APP_TELEGRAM_BOT_USERNAME} \
    NG_APP_GOOGLE_LOGIN=${NG_APP_GOOGLE_LOGIN} \
    NG_APP_DEV_LOGIN=${NG_APP_DEV_LOGIN}
RUN npm run build -w shared && npm run build -w frontend

# Статика за nginx; /api і /socket.io проксіює зовнішній reverse proxy на бекенд.
FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime
COPY frontend/nginx-security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist/frontend/browser /usr/share/nginx/html
EXPOSE 8080
