FROM node:24-alpine
ARG PLAYER_UID=1000
ARG PLAYER_GID=1000
WORKDIR /app
RUN chown ${PLAYER_UID}:${PLAYER_GID} /app
USER ${PLAYER_UID}:${PLAYER_GID}
COPY --chown=${PLAYER_UID}:${PLAYER_GID} frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY --chown=${PLAYER_UID}:${PLAYER_GID} frontend/ ./
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
