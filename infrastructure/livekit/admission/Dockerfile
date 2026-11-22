FROM golang:1.26-alpine AS builder
WORKDIR /src
# LiveKit v1.13.11. Verify the upstream archive before applying the local policy.
ADD --checksum=sha256:3e55849d55ddb01df0407f0896d564d09e9b2b6697be1a827c9f4854e963dbff https://codeload.github.com/livekit/livekit/tar.gz/385aa40f9292fe1db8caad87301e4b285b7c198a /tmp/livekit.tgz
RUN tar -xzf /tmp/livekit.tgz --strip-components=1 && go mod download
COPY track-admission.patch /tmp/track-admission.patch
RUN apk add --no-cache patch && patch -p1 < /tmp/track-admission.patch
COPY screen_slots*.go pkg/rtc/
RUN --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=0 go test pkg/rtc/screen_slots*.go && CGO_ENABLED=0 go build -trimpath -o /livekit-server ./cmd/server
FROM livekit/livekit-server:v1.13.11
COPY --from=builder /livekit-server /livekit-server
