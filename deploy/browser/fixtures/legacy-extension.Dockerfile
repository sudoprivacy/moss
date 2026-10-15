# Reproduce the extension before minimum-version bootstrap was introduced.
# Build context is the public SDK v0.54.0 checkout. The worker's other behavior
# is shared with the current image; only the prior bootstrap contract differs.
ARG BROWSER_WORKER_IMAGE
FROM ${BROWSER_WORKER_IMAGE}
USER root
COPY ai_dev_browser/extension /opt/browser/sdk/ai_dev_browser/extension
RUN --mount=type=secret,id=extension_key,required=true python3 -c 'import pathlib; p=pathlib.Path("/opt/browser/configure_extension.py"); text=p.read_text(); assert text.count("output.mkdir()")==1; p.write_text(text.replace("output.mkdir()","output.mkdir(exist_ok=True)"))' \
    && python3 /opt/browser/configure_extension.py /run/secrets/extension_key \
    && /opt/browser/venv/bin/python -c 'import inspect,pathlib; from ai_dev_browser.remote.worker import Worker; p=pathlib.Path(inspect.getfile(Worker)); text=p.read_text(); needle="minimum_version=installed_identity[\"version\"],"; assert text.count(needle)==1; p.write_text(text.replace(needle,"minimum_version=None,",1))' \
    && chown -R browser:browser /opt/browser/extension
USER browser
