ARG BROWSER_WORKER_IMAGE
FROM ${BROWSER_WORKER_IMAGE}
USER root
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN /opt/browser/venv/bin/pip install --no-cache-dir 'pytest>=8,<10' 'pytest-asyncio>=0.24,<2'
COPY test_lifecycle_live.py conftest.py /opt/browser/
USER browser
ENV MOSS_BROWSER_LIVE_TRANSPORTS=cdp,extension MOSS_BROWSER_TEST_HEADFUL=1
CMD ["/opt/browser/venv/bin/python", "-m", "pytest", "/opt/browser/test_lifecycle_live.py", "-q", "--tb=short", "-p", "no:cacheprovider"]
