# Build with the existing Moss runtime image and verified release artifacts.
# The context contains scode, nexusd-cohost and the signed plugins directory.
ARG RUNTIME_BASE
FROM ${RUNTIME_BASE}
COPY scode nexusd-cohost /usr/local/bin/
COPY plugins/ /opt/scode-plugins/
RUN chmod 0755 /usr/local/bin/scode /usr/local/bin/nexusd-cohost \
    && scode --version \
    && nexusd-cohost --version \
    && test -s /opt/scode-plugins/libnexus_vault.so \
    && test -s /opt/scode-plugins/libnexus_vault.so.sig \
    && mkdir -p /home/agent \
    && chown 1000:1000 /home/agent
ENV HOME=/home/agent
WORKDIR /home/agent
USER 1000:1000
CMD ["nexusd-cohost", "--help"]
