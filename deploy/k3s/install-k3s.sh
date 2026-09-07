#!/usr/bin/env bash
# Superseded by `install.sh --role compute`, which provisions the same k3s +
# gvisor + runtime-image node. Kept so existing runbooks and bookmarked URLs
# keep working; it forwards and prints the command to use from now on.
#
# There is one installer entry point:
#   sudo ./install.sh --role all-in-one     # Moss Server + session runtime
#   sudo ./install.sh --role control-plane  # Moss Server only
#   sudo ./install.sh --role compute        # session runtime only  <- this file
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for candidate in "$SCRIPT_DIR/../install.sh" "$SCRIPT_DIR/install.sh"; do
  if [ -f "$candidate" ]; then
    INSTALLER="$candidate"
    break
  fi
done

printf '[k3s-install] install-k3s.sh is now `install.sh --role compute`.\n' >&2

if [ -z "${INSTALLER:-}" ]; then
  # Piped straight from a release URL, so there is no sibling file to reuse.
  COS_BASE="${MOSS_COS_BASE:-https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server}"
  INSTALLER="$(mktemp)"
  printf '[k3s-install] fetching install.sh from %s/latest\n' "$COS_BASE" >&2
  curl -fsSL "$COS_BASE/latest/install.sh" -o "$INSTALLER" || {
    printf '[k3s-install] ERROR: could not download install.sh; run it directly with --role compute\n' >&2
    exit 1
  }
  trap 'rm -f "$INSTALLER"' EXIT
  bash "$INSTALLER" --role compute "$@"
  exit $?
fi

exec bash "$INSTALLER" --role compute "$@"
