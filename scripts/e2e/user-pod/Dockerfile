FROM node:22.22.1-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
ENTRYPOINT []
