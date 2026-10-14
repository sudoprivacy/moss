# Branded Chrome with a machine-managed ai-dev-browser bridge. Display tools
# are available in the image but no display process runs in headless mode.
ARG ADB_BROWSER_IMAGE
FROM ${ADB_BROWSER_IMAGE}
COPY worker.py profile_lease.py mcp-tools.json /opt/browser/
USER browser
WORKDIR /opt/browser
EXPOSE 8080
CMD ["/opt/browser/venv/bin/python", "/opt/browser/worker.py"]
