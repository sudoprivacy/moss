#!/usr/bin/env bash
# Both host and session images consume the same pinned, architecture-specific payload.
set -euo pipefail
VERSIONS="${1:?usage: fetch-scode.sh VERSIONS_JSON ARCH DESTINATION}"
ARCH="${2:?architecture required}"
DESTINATION="${3:?destination required}"
case "$ARCH" in
  amd64) PAYLOAD=scode-linux-x64-bundle ;;
  arm64) PAYLOAD=scode-linux-arm64 ;;
  *) echo "Unsupported scode architecture: $ARCH" >&2; exit 1 ;;
esac
VERSION="$(jq -er '.scode' "$VERSIONS")"
SHA256="$(jq -er --arg key "$PAYLOAD-sha256" '.[$key]' "$VERSIONS")"
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]] || { echo 'Invalid scode version' >&2; exit 1; }
[[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "Missing pinned checksum for $PAYLOAD" >&2; exit 1; }
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
curl -fsSL --retry 3 --connect-timeout 15 --max-time 300 -H 'Accept: application/octet-stream' \
  "${SCODE_DOWNLOAD_URL:-https://github.com/sudoprivacy/sudocode/releases/download/$VERSION/$PAYLOAD.tar.gz}" \
  -o "$STAGING/payload.tar.gz"
echo "$SHA256  $STAGING/payload.tar.gz" | sha256sum -c -
tar -xzf "$STAGING/payload.tar.gz" -C "$STAGING"
if [[ "$PAYLOAD" == *-bundle ]]; then
  (cd "$STAGING/$PAYLOAD" && sha256sum -c SHA256SUMS.txt)
fi
mkdir -p "$(dirname "$DESTINATION")"
install -m 0755 "$STAGING/$PAYLOAD/scode" "$DESTINATION"
printf '%s\n' "$VERSION" > "$DESTINATION.version"
