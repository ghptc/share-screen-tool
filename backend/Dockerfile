FROM golang:1.26-alpine AS build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /server ./cmd/server

FROM build AS programs
RUN CGO_ENABLED=0 go build -trimpath -o /discord-bot ./cmd/discord-bot && CGO_ENABLED=0 go build -trimpath -o /discord-fixture ./cmd/discord-fixture

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /server /server
COPY --from=programs /discord-bot /discord-bot
COPY --from=programs /discord-fixture /discord-fixture
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/server"]
