FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /agent
COPY *.py *.mjs ./
ENV PYTHONUNBUFFERED=1
CMD ["python", "agent.py", "--config", "/config/agent.json"]
