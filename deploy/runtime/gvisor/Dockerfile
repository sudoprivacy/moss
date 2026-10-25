FROM debian:bookworm-slim@sha256:0104b334637a5f19aa9c983a91b54c89887c0984081f2068983107a6f6c21eeb

COPY install-build-deps.sh /usr/local/libexec/gvisor-build-deps
RUN nice -n 10 sh /usr/local/libexec/gvisor-build-deps
WORKDIR /work
