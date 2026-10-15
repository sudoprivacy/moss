FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
WORKDIR /app
COPY dist/http-agent-provider/http-agent-provider.mjs /app/provider.mjs
USER 10001:10001
ENTRYPOINT ["node", "/app/provider.mjs", "/run/provider/provider.json"]
