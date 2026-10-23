# Install a checksum-verified Chrome release on the supplied browser image.
ARG BROWSER_BASE_IMAGE
FROM ${BROWSER_BASE_IMAGE}
USER root
ARG CHROME_VERSION
ARG CHROME_SHA256
RUN test -n "$CHROME_VERSION" && test -n "$CHROME_SHA256" \
    && curl -fsSLo /tmp/chrome.deb "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_amd64.deb" \
    && printf '%s  /tmp/chrome.deb\n' "$CHROME_SHA256" | sha256sum --check --strict - \
    && dpkg -i /tmp/chrome.deb \
    && test "$(dpkg-query -W -f='${Version}' google-chrome-stable)" = "$CHROME_VERSION" \
    && rm /tmp/chrome.deb
USER browser
