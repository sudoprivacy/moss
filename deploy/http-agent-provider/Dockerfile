FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
WORKDIR /app
ARG SOURCE_REVISION
COPY dist/http-agent-provider/http-agent-provider.mjs /app/http-agent-provider.mjs
COPY dist/http-agent-provider/artifact-manifest.json /app/artifact-manifest.json
COPY scripts/http-agent-artifact.mjs /app/verify-artifact.mjs
RUN node /app/verify-artifact.mjs --directory /app --revision "$SOURCE_REVISION"
LABEL org.opencontainers.image.source="https://github.com/sudoprivacy/moss" \
      org.opencontainers.image.revision="$SOURCE_REVISION"
USER 10001:10001
ENTRYPOINT ["node", "/app/http-agent-provider.mjs", "/run/provider/provider.json"]
