# Branded Chrome with a machine-managed ai-dev-browser bridge. Display tools
# are available in the image but no display process runs in headless mode.
ARG ADB_BROWSER_IMAGE
FROM ${ADB_BROWSER_IMAGE}
USER root
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN /opt/browser/venv/bin/pip install --no-cache-dir 'ai-dev-browser[remote]==0.57.4'
# Use the installed public release, rather than the base image's source copy.
ENV PYTHONPATH=""
COPY worker.py mcp-tools.json /opt/browser/
USER browser
WORKDIR /opt/browser
EXPOSE 8080
CMD ["/opt/browser/venv/bin/python", "/opt/browser/worker.py"]
