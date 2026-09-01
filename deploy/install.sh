#!/usr/bin/env bash
set -euo pipefail

RELEASE_TAG="${MOSS_RELEASE_TAG:-@@MOSS_RELEASE_TAG@@}"
DEFAULT_DOWNLOAD_BASE="https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/releases/$RELEASE_TAG"
DEFAULT_INSTALL_DIR=""
NETWORK_NAME="moss-network"
SERVICE_NAME="moss-server"
OFFLINE=0
DOWNLOAD_ONLY=0
DOWNLOAD_DIR=""
UPGRADE_ONLY="${MOSS_PROGRAM_UPGRADE:-0}"
INSTALLER_REFRESHED="${MOSS_INSTALLER_REFRESHED:-0}"
NON_INTERACTIVE="${MOSS_NON_INTERACTIVE:-0}"
INSTALL_DIR="${MOSS_INSTALL_DIR:-}"

log() { printf '[moss-install] %s\n' "$*"; }
die() { printf '[moss-install] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --offline                 Read release archives next to this script.
  --download PATH           Download files for a later offline installation.
  --upgrade                 Upgrade an existing installation without changing user data.
  --install-dir PATH        Installation root (default: <install-user-home>/.moss/server).
  --non-interactive         Read configuration from MOSS_* environment variables.
  -h, --help                Show this help.

Configuration environment variables:
  MOSS_INSTALL_USER, MOSS_INSTALL_DIR, MOSS_PORT, MOSS_ADVERTISED_HOST,
  MOSS_ADMIN_USERNAME, MOSS_ADMIN_PASSWORD, MOSS_DOWNLOAD_BASE, MOSS_INSTALLER_URL,
  ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --offline) OFFLINE=1 ;;
    --upgrade) UPGRADE_ONLY=1 ;;
    --download)
      [ "$#" -ge 2 ] || die "--download requires a path"
      DOWNLOAD_ONLY=1
      DOWNLOAD_DIR="$2"
      shift
      ;;
    --install-dir)
      [ "$#" -ge 2 ] || die "--install-dir requires a path"
      INSTALL_DIR="$2"
      shift
      ;;
    --non-interactive) NON_INTERACTIVE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[ "$OFFLINE" = 0 ] || [ "$DOWNLOAD_ONLY" = 0 ] \
  || die "--offline and --download cannot be used together"
[ "$UPGRADE_ONLY" = 0 ] || [ "$DOWNLOAD_ONLY" = 0 ] \
  || die "--upgrade and --download cannot be used together"
ARCH=amd64

case "$RELEASE_TAG" in
  server-v*) VERSION="${RELEASE_TAG#server-v}" ;;
  *) die "invalid server release tag: $RELEASE_TAG" ;;
esac

SERVER_ARCHIVE="moss-server-$VERSION-linux-$ARCH.tar.gz"
RUNTIME_ARCHIVE="moss-runtime-$VERSION-linux-$ARCH.tar.gz"

if [ "$DOWNLOAD_ONLY" = 1 ]; then
  command -v curl >/dev/null 2>&1 || die "curl is required"
  if command -v sha256sum >/dev/null 2>&1; then
    CHECKSUM_COMMAND=(sha256sum -c)
  elif command -v shasum >/dev/null 2>&1; then
    CHECKSUM_COMMAND=(shasum -a 256 -c)
  else
    die "sha256sum or shasum is required"
  fi

  mkdir -p "$DOWNLOAD_DIR"
  DOWNLOAD_DIR="$(cd "$DOWNLOAD_DIR" && pwd)"
  DOWNLOAD_BASE="${MOSS_DOWNLOAD_BASE:-$DEFAULT_DOWNLOAD_BASE}"
  DOWNLOAD_BASE="${DOWNLOAD_BASE%/}"

  download_offline_file() {
    local step="$1" filename="$2"
    log "Downloading [$step/4] $filename"
    curl --fail --location --progress-bar --retry 3 --connect-timeout 20 \
      -o "$DOWNLOAD_DIR/$filename" "$DOWNLOAD_BASE/$filename"
  }

  download_offline_file 1 install.sh
  download_offline_file 2 SHA256SUMS
  for archive in "$SERVER_ARCHIVE" "$RUNTIME_ARCHIVE"; do
    if ! awk -v filename="$archive" '$2 == filename || $2 == "*" filename { found=1 } END { exit found ? 0 : 1 }' \
      "$DOWNLOAD_DIR/SHA256SUMS"; then
      die "checksum manifest does not contain $archive"
    fi
  done
  download_offline_file 3 "$SERVER_ARCHIVE"
  download_offline_file 4 "$RUNTIME_ARCHIVE"

  for archive in "$SERVER_ARCHIVE" "$RUNTIME_ARCHIVE"; do
    CHECKSUM_FILE="$(mktemp)"
    awk -v filename="$archive" '$2 == filename || $2 == "*" filename { print }' \
      "$DOWNLOAD_DIR/SHA256SUMS" > "$CHECKSUM_FILE"
    (cd "$DOWNLOAD_DIR" && "${CHECKSUM_COMMAND[@]}" "$CHECKSUM_FILE")
    rm -f "$CHECKSUM_FILE"
  done
  EXPECTED_RELEASE_LINE="$(printf 'RELEASE_TAG="${MOSS_RELEASE_TAG:-%s}"' "$RELEASE_TAG")"
  grep -Fq "$EXPECTED_RELEASE_LINE" "$DOWNLOAD_DIR/install.sh" \
    || die "downloaded install.sh does not match $RELEASE_TAG"
  chmod +x "$DOWNLOAD_DIR/install.sh"

  log "Offline files are ready: $DOWNLOAD_DIR"
  log "Copy this directory to the target server, then run: sudo ./install.sh --offline"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || die "run as root (for example: curl ... | sudo bash)"
[ "$(uname -s)" = Linux ] || die "only Linux is supported"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) die "only x86_64/amd64 is supported" ;;
esac

command -v getent >/dev/null 2>&1 || die "getent is required"
resolve_install_account() {
  PASSWD_ENTRY="$(getent passwd "$INSTALL_USER" || true)"
  [ -n "$PASSWD_ENTRY" ] || die "install user does not exist: $INSTALL_USER"
  INSTALL_USER_HOME="$(printf '%s\n' "$PASSWD_ENTRY" | awk -F: 'NR == 1 { print $6 }')"
  INSTALL_USER_GROUP="$(id -gn "$INSTALL_USER")"
  case "$INSTALL_USER_HOME" in
    /*) ;;
    *) die "install user has no absolute home directory: $INSTALL_USER" ;;
  esac
  [ -d "$INSTALL_USER_HOME" ] || die "install user home does not exist: $INSTALL_USER_HOME"
}

INSTALL_USER="${MOSS_INSTALL_USER:-${SUDO_USER:-$(id -un)}}"
resolve_install_account
DEFAULT_INSTALL_DIR="${INSTALL_USER_HOME%/}/.moss/server"

read_masked_value() {
  local label="$1" value='' char='' tty_state=''
  tty_state="$(stty -g < /dev/tty)"
  trap 'stty "$tty_state" < /dev/tty' EXIT
  trap 'exit 130' HUP INT TERM
  stty -echo < /dev/tty
  printf '%s' "$label" > /dev/tty
  while IFS= read -r -n 1 char < /dev/tty; do
    case "$char" in
      '') break ;;
      $'\177'|$'\b')
        if [ -n "$value" ]; then
          value="${value%?}"
          printf '\b \b' > /dev/tty
        fi
        ;;
      *)
        value+="$char"
        printf '*' > /dev/tty
        ;;
    esac
  done
  stty "$tty_state" < /dev/tty
  trap - EXIT HUP INT TERM
  printf '\n' > /dev/tty
  printf '%s' "$value"
}

prompt_value() {
  local variable="$1" label="$2" default_value="$3" secret="${4:-0}"
  local confirmation_label="${5:-}" mismatch_message="${6:-Values do not match; try again.}"
  local current="${!variable:-}" answer='' confirmation=''
  if [ -n "$current" ]; then
    return
  fi
  if [ "$NON_INTERACTIVE" = 1 ]; then
    printf -v "$variable" '%s' "$default_value"
    return
  fi
  if [ "$secret" = 1 ]; then
    while true; do
      answer="$(read_masked_value "$label")"
      if [ -z "$answer" ] || [ -z "$confirmation_label" ]; then
        break
      fi
      confirmation="$(read_masked_value "$confirmation_label")"
      if [ "$answer" = "$confirmation" ]; then
        break
      fi
      printf '[moss-install] %s\n' "$mismatch_message" > /dev/tty
    done
  else
    if [ -n "$default_value" ]; then
      printf '%s [%s]: ' "$label" "$default_value" > /dev/tty
    else
      printf '%s: ' "$label" > /dev/tty
    fi
    IFS= read -r answer < /dev/tty || true
  fi
  printf -v "$variable" '%s' "${answer:-$default_value}"
}

USING_DEFAULT_INSTALL_DIR=0
if [ -z "$INSTALL_DIR" ] && [ -f "/etc/systemd/system/$SERVICE_NAME.service" ]; then
  EXISTING_ENV_PATH="$(awk -F= '$1 == "EnvironmentFile" { print substr($0, index($0, "=") + 1); exit }' \
    "/etc/systemd/system/$SERVICE_NAME.service")"
  if [ -n "$EXISTING_ENV_PATH" ] && [ -f "$EXISTING_ENV_PATH" ]; then
    EXISTING_INSTALL_DIR="$(dirname "$EXISTING_ENV_PATH")"
    if [ -f "$EXISTING_INSTALL_DIR/server.json" ]; then
      INSTALL_DIR="$EXISTING_INSTALL_DIR"
      log "Existing service found; using install directory: $INSTALL_DIR"
    fi
  fi
fi
[ -n "$INSTALL_DIR" ] || USING_DEFAULT_INSTALL_DIR=1
if [ "$UPGRADE_ONLY" = 1 ]; then
  INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
else
  prompt_value INSTALL_DIR 'Install directory' "$DEFAULT_INSTALL_DIR"
fi
case "$INSTALL_DIR" in
  /*) ;;
  *) die "install directory must be an absolute path" ;;
esac
case "$INSTALL_DIR" in
  *[[:space:]]*) die "install directory must not contain whitespace" ;;
esac
[ "$INSTALL_DIR" != / ] || die "refusing to install into /"

if [ -f "$INSTALL_DIR/server.json" ]; then
  EXISTING_INSTALL_USER="$(stat -c %U "$INSTALL_DIR")"
  if [ -n "${MOSS_INSTALL_USER:-}" ] && [ "$EXISTING_INSTALL_USER" != "$INSTALL_USER" ]; then
    die "existing installation belongs to $EXISTING_INSTALL_USER; service-user migration is not supported"
  fi
  if [ -z "${MOSS_INSTALL_USER:-}" ] && [ -n "$EXISTING_INSTALL_USER" ] \
    && [ "$EXISTING_INSTALL_USER" != "$INSTALL_USER" ]; then
    INSTALL_USER="$EXISTING_INSTALL_USER"
    resolve_install_account
  fi
fi
[ "$UPGRADE_ONLY" = 0 ] || [ -f "$INSTALL_DIR/server.json" ] \
  || die "no existing Moss Server installation found in $INSTALL_DIR"
log "Service user: $INSTALL_USER"
log "Install directory: $INSTALL_DIR"

INSTALLED_RELEASE_DIR="$(readlink -f "$INSTALL_DIR/current" 2>/dev/null || true)"
INSTALLED_RELEASE_TAG="${INSTALLED_RELEASE_DIR##*/}"
CURRENT_SCRIPT="${BASH_SOURCE[0]:-}"
RUNNING_INSTALLED_SCRIPT=0
if [ -n "$CURRENT_SCRIPT" ] && [ -f "$CURRENT_SCRIPT" ] \
  && [ -f "$INSTALL_DIR/install.sh" ] \
  && [ "$(readlink -f "$CURRENT_SCRIPT")" = "$(readlink -f "$INSTALL_DIR/install.sh")" ]; then
  RUNNING_INSTALLED_SCRIPT=1
fi

SKIP_SAME_RELEASE=0
if [ -f "$INSTALL_DIR/server.json" ] && [ "$INSTALLED_RELEASE_TAG" = "$RELEASE_TAG" ]; then
  if [ "$UPGRADE_ONLY" = 0 ] || [ "$OFFLINE" = 1 ] || [ "$INSTALLER_REFRESHED" = 1 ] \
    || [ "$RUNNING_INSTALLED_SCRIPT" = 0 ]; then
    SKIP_SAME_RELEASE=1
  fi
fi

if [ "$SKIP_SAME_RELEASE" = 1 ]; then
  if [ -n "$CURRENT_SCRIPT" ] && [ -f "$CURRENT_SCRIPT" ] \
    && [ "$CURRENT_SCRIPT" != "$INSTALL_DIR/install.sh" ]; then
    install -m 755 -o "$INSTALL_USER" -g "$INSTALL_USER_GROUP" \
      "$CURRENT_SCRIPT" "$INSTALL_DIR/install.sh"
  fi
  log "Moss Server $RELEASE_TAG is already installed; no downloads needed"
  exit 0
fi

if [ "$UPGRADE_ONLY" = 1 ] && [ "$OFFLINE" = 0 ] && [ "$INSTALLER_REFRESHED" != 1 ]; then
  command -v curl >/dev/null 2>&1 || die "curl is required"
  LATEST_INSTALLER_URL="${MOSS_INSTALLER_URL:-https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/latest/install.sh}"
  LATEST_INSTALLER="$(mktemp)"
  log "Downloading latest installer"
  if ! curl --fail --location --progress-bar --retry 3 --connect-timeout 20 \
    -o "$LATEST_INSTALLER" "$LATEST_INSTALLER_URL"; then
    rm -f "$LATEST_INSTALLER"
    die "could not download latest installer"
  fi
  chmod +x "$LATEST_INSTALLER"
  set +e
  MOSS_PROGRAM_UPGRADE=1 MOSS_INSTALLER_REFRESHED=1 \
    MOSS_INSTALL_USER="$INSTALL_USER" MOSS_INSTALL_DIR="$INSTALL_DIR" \
    bash "$LATEST_INSTALLER"
  UPGRADE_STATUS=$?
  set -e
  rm -f "$LATEST_INSTALLER"
  exit "$UPGRADE_STATUS"
fi

command -v ldd >/dev/null 2>&1 || die "ldd is required"
GLIBC_VERSION="$(ldd --version 2>&1 | awk '
  NR == 1 {
    for (i = NF; i >= 1; i--) {
      if ($i ~ /^[0-9]+\.[0-9]+$/) {
        print $i
        found = 1
        break
      }
    }
  }
  END { if (!found) exit 1 }
')"
[ -n "$GLIBC_VERSION" ] || die "could not determine glibc version"
GLIBC_MAJOR="${GLIBC_VERSION%%.*}"
GLIBC_MINOR="${GLIBC_VERSION#*.}"
if [ "$GLIBC_MAJOR" -lt 2 ] || { [ "$GLIBC_MAJOR" -eq 2 ] && [ "$GLIBC_MINOR" -lt 39 ]; }; then
  die "glibc 2.39 or newer is required for host scode (Ubuntu 24.04+); found $GLIBC_VERSION"
fi

for command_name in tar gzip sha256sum systemctl docker curl install stat stty; do
  command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required"
done
docker info >/dev/null 2>&1 || die "Docker daemon is not available"

DOCKER_SOCKET="/var/run/docker.sock"
[ -S "$DOCKER_SOCKET" ] || die "Docker socket is not available: $DOCKER_SOCKET"
DOCKER_GROUP_ID="$(stat -c %g "$DOCKER_SOCKET")"
DOCKER_GROUP_ENTRY="$(getent group "$DOCKER_GROUP_ID" || true)"
[ -n "$DOCKER_GROUP_ENTRY" ] || die "Docker socket group does not exist: $DOCKER_GROUP_ID"
DOCKER_GROUP="${DOCKER_GROUP_ENTRY%%:*}"

DOCKER_VERSION="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
DOCKER_MAJOR="${DOCKER_VERSION%%.*}"
DOCKER_REST="${DOCKER_VERSION#*.}"
DOCKER_MINOR="${DOCKER_REST%%.*}"
if [ -z "$DOCKER_VERSION" ] || [ "${DOCKER_MAJOR:-0}" -lt 20 ] \
  || { [ "$DOCKER_MAJOR" -eq 20 ] && [ "${DOCKER_MINOR:-0}" -lt 10 ]; }; then
  die "Docker daemon 20.10 or newer is required; found ${DOCKER_VERSION:-unknown}"
fi

if [ "$USING_DEFAULT_INSTALL_DIR" = 1 ]; then
  install -d -m 700 -o "$INSTALL_USER" -g "$INSTALL_USER_GROUP" "$INSTALL_USER_HOME/.moss"
fi
install -d -m 700 -o "$INSTALL_USER" -g "$INSTALL_USER_GROUP" \
  "$INSTALL_DIR" "$INSTALL_DIR/packages"

WORK_DIR="$(mktemp -d)"
DOWNLOAD_PART=""
cleanup() {
  rm -rf "$WORK_DIR"
  [ -z "$DOWNLOAD_PART" ] || rm -f "$DOWNLOAD_PART"
}
trap cleanup EXIT

if [ "$OFFLINE" = 1 ]; then
  SCRIPT_PATH="${BASH_SOURCE[0]:-}"
  [ -n "$SCRIPT_PATH" ] || die "--offline must be run from the unpacked install.sh file"
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  SOURCE_DIR="$SCRIPT_DIR"
  [ -f "$SOURCE_DIR/$SERVER_ARCHIVE" ] || die "missing offline asset: $SERVER_ARCHIVE"
  [ -f "$SOURCE_DIR/$RUNTIME_ARCHIVE" ] || die "missing offline asset: $RUNTIME_ARCHIVE"
  [ -f "$SOURCE_DIR/SHA256SUMS" ] || die "missing offline asset: SHA256SUMS"
else
  SOURCE_DIR="$INSTALL_DIR/packages/$RELEASE_TAG"
  install -d -m 700 -o "$INSTALL_USER" -g "$INSTALL_USER_GROUP" "$SOURCE_DIR"
  DOWNLOAD_BASE="${MOSS_DOWNLOAD_BASE:-$DEFAULT_DOWNLOAD_BASE}"
  DOWNLOAD_BASE="${DOWNLOAD_BASE%/}"

  download_asset() {
    local step="$1" filename="$2"
    log "Downloading [$step/4] $filename"
    DOWNLOAD_PART="$SOURCE_DIR/.$filename.part.$$"
    rm -f "$DOWNLOAD_PART"
    if ! curl --fail --location --progress-bar --retry 3 --connect-timeout 20 \
      -o "$DOWNLOAD_PART" "$DOWNLOAD_BASE/$filename"; then
      rm -f "$DOWNLOAD_PART"
      DOWNLOAD_PART=""
      die "could not download $filename"
    fi
    mv -f "$DOWNLOAD_PART" "$SOURCE_DIR/$filename"
    DOWNLOAD_PART=""
  }

  cached_asset_is_valid() {
    local filename="$1" checksum_file=''
    checksum_file="$WORK_DIR/$filename.cached.sha256"
    [ -f "$SOURCE_DIR/$filename" ] || return 1
    awk -v filename="$filename" '$2 == filename || $2 == "*" filename { print }' \
      "$SOURCE_DIR/SHA256SUMS" > "$checksum_file"
    [ -s "$checksum_file" ] \
      && (cd "$SOURCE_DIR" && sha256sum -c "$checksum_file" >/dev/null 2>&1)
  }

  CURRENT_SCRIPT="${BASH_SOURCE[0]:-}"
  if [ -n "$CURRENT_SCRIPT" ] && [ -f "$CURRENT_SCRIPT" ]; then
    log "Preparing [1/4] install.sh"
    if [ "$CURRENT_SCRIPT" != "$SOURCE_DIR/install.sh" ]; then
      install -m 755 "$CURRENT_SCRIPT" "$SOURCE_DIR/install.sh"
    else
      chmod 755 "$SOURCE_DIR/install.sh"
    fi
  else
    download_asset 1 install.sh
  fi
  download_asset 2 SHA256SUMS
  for archive in "$SERVER_ARCHIVE" "$RUNTIME_ARCHIVE"; do
    if ! awk -v filename="$archive" '$2 == filename || $2 == "*" filename { found=1 } END { exit found ? 0 : 1 }' \
      "$SOURCE_DIR/SHA256SUMS"; then
      die "checksum manifest does not contain $archive; the download source is incomplete"
    fi
  done
  step=3
  for archive in "$SERVER_ARCHIVE" "$RUNTIME_ARCHIVE"; do
    if cached_asset_is_valid "$archive"; then
      log "Using cached [$step/4] $archive"
    else
      rm -f "$SOURCE_DIR/$archive"
      download_asset "$step" "$archive"
    fi
    step=$((step + 1))
  done
  chmod 644 "$SOURCE_DIR/SHA256SUMS" "$SOURCE_DIR/$SERVER_ARCHIVE" "$SOURCE_DIR/$RUNTIME_ARCHIVE"
  chown -R "$INSTALL_USER:$INSTALL_USER_GROUP" "$SOURCE_DIR"
fi

EXPECTED_RELEASE_LINE="$(printf 'RELEASE_TAG="${MOSS_RELEASE_TAG:-%s}"' "$RELEASE_TAG")"
grep -Fq "$EXPECTED_RELEASE_LINE" "$SOURCE_DIR/install.sh" \
  || die "installer script does not match $RELEASE_TAG"

verify_asset() {
  local filename="$1"
  awk -v filename="$filename" '$2 == filename || $2 == "*" filename { print }' \
    "$SOURCE_DIR/SHA256SUMS" > "$WORK_DIR/$filename.sha256"
  [ -s "$WORK_DIR/$filename.sha256" ] || die "no checksum found for $filename"
  (cd "$SOURCE_DIR" && sha256sum -c "$WORK_DIR/$filename.sha256")
}
verify_asset "$SERVER_ARCHIVE"
verify_asset "$RUNTIME_ARCHIVE"

if tar -tzf "$SOURCE_DIR/$SERVER_ARCHIVE" \
  | awk '$0 !~ /^moss-server\// || $0 ~ /(^|\/)\.\.($|\/)/ { bad=1 } END { exit bad ? 0 : 1 }'; then
  die "server archive contains an unsafe path"
fi
tar -xzf "$SOURCE_DIR/$SERVER_ARCHIVE" -C "$WORK_DIR"
PACKAGE_DIR="$WORK_DIR/moss-server"
NODE_BINARY="$PACKAGE_DIR/node/bin/node"
[ -x "$NODE_BINARY" ] || die "server package does not contain Node"
[ "$($NODE_BINARY -p 'process.versions.node.split(`.`)[0]')" -eq 22 ] \
  || die "server package must contain Node 22"
"$NODE_BINARY" --no-warnings -e "require('node:sqlite')" >/dev/null
[ -f "$PACKAGE_DIR/app/bin/moss-server.mjs" ] || die "server package is incomplete"
[ -x "$PACKAGE_DIR/app/bin/scode" ] || die "server package does not contain host scode"
HOST_SCODE_VERSION="$($PACKAGE_DIR/app/bin/scode --version 2>&1)" \
  || die "host scode could not run"
log "Host scode: $HOST_SCODE_VERSION"

log "Loading Docker runtime image"
docker load -i "$SOURCE_DIR/$RUNTIME_ARCHIVE"
RUNTIME_IMAGE="my-moss-runtime:$VERSION-$ARCH"
docker image inspect "$RUNTIME_IMAGE" >/dev/null 2>&1 \
  || die "runtime archive did not load expected image $RUNTIME_IMAGE"

EXISTING_INSTALL=0
[ -f "$INSTALL_DIR/server.json" ] && EXISTING_INSTALL=1
DEFAULT_HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
DEFAULT_HOST="${DEFAULT_HOST:-127.0.0.1}"
EXISTING_PORT=43127
EXISTING_HOST="$DEFAULT_HOST"
if [ "$EXISTING_INSTALL" = 1 ]; then
  EXISTING_PORT="$($NODE_BINARY -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).server.port" "$INSTALL_DIR/server.json")"
  EXISTING_HOST="$($NODE_BINARY -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).server.advertisedHost || '$DEFAULT_HOST'" "$INSTALL_DIR/server.json")"
fi
MOSS_PORT_VALUE="${MOSS_PORT:-}"
MOSS_ADVERTISED_HOST_VALUE="${MOSS_ADVERTISED_HOST:-}"
MOSS_ADMIN_USERNAME_VALUE="${MOSS_ADMIN_USERNAME:-}"
MOSS_ADMIN_PASSWORD_VALUE="${MOSS_ADMIN_PASSWORD:-}"
ANTHROPIC_BASE_URL_VALUE="${ANTHROPIC_BASE_URL:-}"
ANTHROPIC_API_KEY_VALUE="${ANTHROPIC_API_KEY:-}"
GENERATED_PASSWORD=0

if [ "$EXISTING_INSTALL" = 0 ]; then
  prompt_value MOSS_PORT_VALUE 'Service port' '43127'
  prompt_value MOSS_ADVERTISED_HOST_VALUE 'Public server address (IP or hostname)' "$DEFAULT_HOST"
  prompt_value MOSS_ADMIN_USERNAME_VALUE 'Administrator username' 'admin'
  prompt_value MOSS_ADMIN_PASSWORD_VALUE 'Administrator password (blank generates one): ' '' 1 \
    'Confirm administrator password: ' 'Passwords do not match; try again.'
  if [ -z "$MOSS_ADMIN_PASSWORD_VALUE" ]; then
    MOSS_ADMIN_PASSWORD_VALUE="$($NODE_BINARY -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")"
    GENERATED_PASSWORD=1
  fi
  prompt_value ANTHROPIC_BASE_URL_VALUE 'Anthropic API Base URL' 'https://hk.sudorouter.ai/v1'
  prompt_value ANTHROPIC_API_KEY_VALUE 'Anthropic API Key (optional): ' '' 1 \
    'Confirm Anthropic API Key: ' 'API Keys do not match; try again.'
else
  MOSS_PORT_VALUE="$EXISTING_PORT"
  MOSS_ADVERTISED_HOST_VALUE="$EXISTING_HOST"
  log "Existing installation found; upgrading program only"
fi

case "$MOSS_PORT_VALUE" in
  ''|*[!0-9]*) die "port must be numeric" ;;
esac
[ "$MOSS_PORT_VALUE" -ge 1 ] && [ "$MOSS_PORT_VALUE" -le 65535 ] \
  || die "port must be between 1 and 65535"

if [ "$EXISTING_INSTALL" = 0 ] && command -v ss >/dev/null 2>&1 \
  && ss -ltn | awk '{print $4}' | grep -Eq "(^|:)$MOSS_PORT_VALUE$"; then
  die "port $MOSS_PORT_VALUE is already in use"
fi

if ! docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  docker network create "$NETWORK_NAME" >/dev/null
fi
NETWORK_GATEWAY="$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "$NETWORK_NAME")"
[ -n "$NETWORK_GATEWAY" ] || die "could not determine $NETWORK_NAME gateway"

install -d -m 700 -o "$INSTALL_USER" -g "$INSTALL_USER_GROUP" \
  "$INSTALL_DIR" "$INSTALL_DIR/releases" "$INSTALL_DIR/data" "$INSTALL_DIR/.moss" \
  "$INSTALL_DIR/packages"
if [ "$SOURCE_DIR/install.sh" != "$INSTALL_DIR/install.sh" ]; then
  install -m 755 -o "$INSTALL_USER" -g "$INSTALL_USER_GROUP" \
    "$SOURCE_DIR/install.sh" "$INSTALL_DIR/install.sh"
else
  chmod 755 "$INSTALL_DIR/install.sh"
  chown "$INSTALL_USER:$INSTALL_USER_GROUP" "$INSTALL_DIR/install.sh"
fi
RELEASE_DIR="$INSTALL_DIR/releases/$RELEASE_TAG"
NEW_RELEASE_DIR="$INSTALL_DIR/releases/.$RELEASE_TAG.new.$$"
PREVIOUS_TARGET="$(readlink -f "$INSTALL_DIR/current" 2>/dev/null || true)"
CONFIG_PATH="$INSTALL_DIR/server.json"
CONFIG_BACKUP=""
if [ "$EXISTING_INSTALL" = 1 ]; then
  CONFIG_BACKUP="$WORK_DIR/server.json.backup"
  cp -a "$CONFIG_PATH" "$CONFIG_BACKUP"
fi
SERVICE_STOPPED=0

rollback_on_error() {
  local status=$?
  trap - ERR
  if [ -n "$CONFIG_BACKUP" ] && [ -f "$CONFIG_BACKUP" ]; then
    cp -a "$CONFIG_BACKUP" "$CONFIG_PATH"
  fi
  if [ "$SERVICE_STOPPED" = 1 ] && [ -n "$PREVIOUS_TARGET" ] && [ -d "$PREVIOUS_TARGET" ]; then
    log "Installation failed; restoring $PREVIOUS_TARGET"
    ln -sfn "$PREVIOUS_TARGET" "$INSTALL_DIR/.current.rollback"
    mv -Tf "$INSTALL_DIR/.current.rollback" "$INSTALL_DIR/current"
    systemctl restart "$SERVICE_NAME.service" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap rollback_on_error ERR

if systemctl cat "$SERVICE_NAME.service" >/dev/null 2>&1; then
  systemctl stop "$SERVICE_NAME.service" || true
  SERVICE_STOPPED=1
fi
rm -rf "$NEW_RELEASE_DIR"
cp -a "$PACKAGE_DIR" "$NEW_RELEASE_DIR"
chown -R "$INSTALL_USER:$INSTALL_USER_GROUP" "$NEW_RELEASE_DIR"
rm -rf "$RELEASE_DIR"
mv "$NEW_RELEASE_DIR" "$RELEASE_DIR"

TEMPLATE_PATH="$RELEASE_DIR/server.json.template"
CONFIG_PATH="$CONFIG_PATH" TEMPLATE_PATH="$TEMPLATE_PATH" \
EXISTING_INSTALL="$EXISTING_INSTALL" \
MOSS_INSTALL_ROOT="$INSTALL_DIR" MOSS_PORT_VALUE="$MOSS_PORT_VALUE" \
MOSS_ADVERTISED_HOST_VALUE="$MOSS_ADVERTISED_HOST_VALUE" \
MOSS_ADMIN_USERNAME_VALUE="$MOSS_ADMIN_USERNAME_VALUE" \
MOSS_ADMIN_PASSWORD_VALUE="$MOSS_ADMIN_PASSWORD_VALUE" \
MOSS_RUNTIME_IMAGE="$RUNTIME_IMAGE" MOSS_NETWORK_NAME="$NETWORK_NAME" \
"$RELEASE_DIR/node/bin/node" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const configPath = process.env.CONFIG_PATH
const source = fs.existsSync(configPath) ? configPath : process.env.TEMPLATE_PATH
const config = JSON.parse(fs.readFileSync(source, 'utf8'))
const root = process.env.MOSS_INSTALL_ROOT
const port = Number(process.env.MOSS_PORT_VALUE)
const hostScodePath = path.join(root, 'current', 'app', 'bin', 'scode')
const dockerScodePath = '/usr/local/bin/scode'
if (process.env.EXISTING_INSTALL === '1') {
  const legacyScodePath = config.runtimeDefaults?.scodePath
  config.runtimeDefaults = {
    ...config.runtimeDefaults,
    dockerImage: process.env.MOSS_RUNTIME_IMAGE,
    hostScodePath: config.runtimeDefaults?.hostScodePath
      || (legacyScodePath && legacyScodePath !== dockerScodePath
        ? legacyScodePath
        : hostScodePath),
    dockerScodePath: config.runtimeDefaults?.dockerScodePath
      || (legacyScodePath === dockerScodePath ? legacyScodePath : undefined)
      || dockerScodePath,
  }
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(configPath, 0o600)
  process.exit(0)
}
config.server = { ...config.server, host: '0.0.0.0', port }
if (process.env.MOSS_ADVERTISED_HOST_VALUE) {
  config.server.advertisedHost = process.env.MOSS_ADVERTISED_HOST_VALUE
  config.server.publicBaseUrl = `http://${process.env.MOSS_ADVERTISED_HOST_VALUE}:${port}`
}
if (!fs.existsSync(configPath)) {
  config.bootstrapAdmin = {
    username: process.env.MOSS_ADMIN_USERNAME_VALUE,
    password: process.env.MOSS_ADMIN_PASSWORD_VALUE,
  }
}
config.runtimeDefaults = {
  ...config.runtimeDefaults,
  type: 'docker',
  dockerImage: process.env.MOSS_RUNTIME_IMAGE,
  dockerMode: 'session',
  hostScodePath,
  dockerScodePath,
}
config.storage = {
  rootDir: path.join(root, 'data'),
  dbPath: path.join(root, 'data', 'moss.db'),
  transcriptDir: path.join(root, 'data', 'transcripts'),
  runtimeDir: path.join(root, 'data', 'runtime'),
}
config.docker = { ...config.docker, network: process.env.MOSS_NETWORK_NAME }
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
fs.chmodSync(configPath, 0o600)
NODE

SETTINGS_PATH="$INSTALL_DIR/.moss/settings.json"
if [ "$EXISTING_INSTALL" = 0 ]; then
  SETTINGS_PATH="$SETTINGS_PATH" ANTHROPIC_BASE_URL_VALUE="$ANTHROPIC_BASE_URL_VALUE" \
  ANTHROPIC_API_KEY_VALUE="$ANTHROPIC_API_KEY_VALUE" "$RELEASE_DIR/node/bin/node" <<'NODE'
const fs = require('node:fs')
const settingsPath = process.env.SETTINGS_PATH
let settings = {}
if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
settings.env = { ...settings.env }
if (process.env.ANTHROPIC_BASE_URL_VALUE) settings.env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL_VALUE
if (process.env.ANTHROPIC_API_KEY_VALUE) settings.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY_VALUE
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
fs.chmodSync(settingsPath, 0o600)
NODE
fi

ENV_PATH="$INSTALL_DIR/moss-server.env"
cat > "$ENV_PATH" <<EOF
HOME=$INSTALL_DIR
MOSS_SERVER_CONFIG=$INSTALL_DIR/server.json
MOSS_HOME=$INSTALL_DIR/.moss
MOSS_MODELS_DIR=$INSTALL_DIR/current/app/models
MOSS_NODE_PATH=$INSTALL_DIR/current/node/bin/node
MOSS_AUTH_PROXY_HOST=$NETWORK_GATEWAY
MOSS_AUTH_PROXY_URL=http://$NETWORK_GATEWAY:12013
MOSS_SERVER_URL=http://$NETWORK_GATEWAY:$MOSS_PORT_VALUE
PATH=$INSTALL_DIR/current/node/bin:$INSTALL_DIR/current/app/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EOF
chmod 600 "$ENV_PATH"

ln -sfn "releases/$RELEASE_TAG" "$INSTALL_DIR/.current.new"
mv -Tf "$INSTALL_DIR/.current.new" "$INSTALL_DIR/current"

cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Moss Server
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$INSTALL_USER
Group=$INSTALL_USER_GROUP
SupplementaryGroups=$DOCKER_GROUP
WorkingDirectory=$INSTALL_DIR/current/app
EnvironmentFile=$ENV_PATH
ExecStart=$INSTALL_DIR/current/node/bin/node $INSTALL_DIR/current/app/bin/moss-server.mjs start
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

cat > "$INSTALL_DIR/start.sh" <<EOF
#!/usr/bin/env bash
set -e
systemctl start $SERVICE_NAME.service
EOF
cat > "$INSTALL_DIR/stop.sh" <<EOF
#!/usr/bin/env bash
set -e
systemctl stop $SERVICE_NAME.service
EOF
cat > "$INSTALL_DIR/status.sh" <<EOF
#!/usr/bin/env bash
set -e
systemctl status $SERVICE_NAME.service --no-pager
curl -fsS http://127.0.0.1:$MOSS_PORT_VALUE/healthz
printf '\n'
EOF
cat > "$INSTALL_DIR/uninstall.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
[ "\$(id -u)" -eq 0 ] || { echo 'run as root' >&2; exit 1; }
systemctl disable --now $SERVICE_NAME.service 2>/dev/null || true
rm -f /etc/systemd/system/$SERVICE_NAME.service
systemctl daemon-reload
docker ps -aq --filter label=moss.kind=user-container | xargs -r docker rm -f
if [ "\${1:-}" = --purge ]; then
  rm -rf '$INSTALL_DIR'
  echo 'Moss program and data removed.'
else
  rm -rf '$INSTALL_DIR/current' '$INSTALL_DIR/releases'
  echo 'Moss program removed; data and configuration retained in $INSTALL_DIR.'
fi
EOF
chmod +x "$INSTALL_DIR/start.sh" "$INSTALL_DIR/stop.sh" "$INSTALL_DIR/status.sh" "$INSTALL_DIR/uninstall.sh"
for owned_path in "$CONFIG_PATH" "$ENV_PATH" "$SETTINGS_PATH" \
  "$INSTALL_DIR/install.sh" "$INSTALL_DIR/start.sh" "$INSTALL_DIR/stop.sh" \
  "$INSTALL_DIR/status.sh" "$INSTALL_DIR/uninstall.sh"; do
  [ ! -e "$owned_path" ] || chown "$INSTALL_USER:$INSTALL_USER_GROUP" "$owned_path"
done

systemctl daemon-reload
systemctl enable "$SERVICE_NAME.service" >/dev/null
if ! systemctl restart "$SERVICE_NAME.service"; then
  if [ -n "$CONFIG_BACKUP" ] && [ -f "$CONFIG_BACKUP" ]; then
    cp -a "$CONFIG_BACKUP" "$CONFIG_PATH"
  fi
  if [ -n "$PREVIOUS_TARGET" ] && [ -d "$PREVIOUS_TARGET" ]; then
    ln -sfn "$PREVIOUS_TARGET" "$INSTALL_DIR/.current.rollback"
    mv -Tf "$INSTALL_DIR/.current.rollback" "$INSTALL_DIR/current"
    systemctl restart "$SERVICE_NAME.service" || true
  fi
  die "failed to start $SERVICE_NAME.service"
fi

HEALTHY=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$MOSS_PORT_VALUE/healthz" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done
if [ "$HEALTHY" != 1 ]; then
  journalctl -u "$SERVICE_NAME.service" -n 80 --no-pager >&2 || true
  if [ -n "$CONFIG_BACKUP" ] && [ -f "$CONFIG_BACKUP" ]; then
    cp -a "$CONFIG_BACKUP" "$CONFIG_PATH"
  fi
  if [ -n "$PREVIOUS_TARGET" ] && [ -d "$PREVIOUS_TARGET" ]; then
    log "Health check failed; rolling back to $PREVIOUS_TARGET"
    systemctl stop "$SERVICE_NAME.service" || true
    ln -sfn "$PREVIOUS_TARGET" "$INSTALL_DIR/.current.rollback"
    mv -Tf "$INSTALL_DIR/.current.rollback" "$INSTALL_DIR/current"
    systemctl restart "$SERVICE_NAME.service" || true
  fi
  die "health check failed on port $MOSS_PORT_VALUE"
fi

SERVICE_STOPPED=0
trap - ERR

if [ "$EXISTING_INSTALL" = 1 ]; then
  log "Moss Server upgraded to $RELEASE_TAG successfully"
else
  log "Moss Server $RELEASE_TAG installed successfully"
fi
log "URL: http://$MOSS_ADVERTISED_HOST_VALUE:$MOSS_PORT_VALUE/admin/"
if [ "$EXISTING_INSTALL" = 0 ]; then
  log "Administrator: $MOSS_ADMIN_USERNAME_VALUE"
  if [ "$GENERATED_PASSWORD" = 1 ]; then
    log "Generated administrator password: $MOSS_ADMIN_PASSWORD_VALUE"
  fi
fi
log "Start: sudo systemctl start $SERVICE_NAME"
log "Stop: sudo systemctl stop $SERVICE_NAME"
log "Restart: sudo systemctl restart $SERVICE_NAME"
log "Status: sudo systemctl status $SERVICE_NAME"
log "Logs: sudo journalctl -u $SERVICE_NAME.service -f"
log "Upgrade: sudo $INSTALL_DIR/install.sh --upgrade"
log "Uninstall: sudo $INSTALL_DIR/uninstall.sh"
if [ "$OFFLINE" = 0 ]; then
  log "Packages: $SOURCE_DIR"
else
  log "Offline packages retained: $SOURCE_DIR"
fi
