FROM node:24-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN VITE_NATIVE_AUDIO_MODE=pair npm run build

FROM caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0
COPY --from=build /app/dist /srv
COPY infrastructure/discord-player/Caddyfile /etc/caddy/Caddyfile
COPY infrastructure/discord-player/player-routes.caddy /etc/caddy/player-routes.caddy
