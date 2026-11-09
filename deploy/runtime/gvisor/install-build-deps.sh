#!/bin/sh
set -eu

export DEBIAN_FRONTEND=noninteractive
apt-get update
case "$(dpkg --print-architecture)" in
  amd64) architecture_deps='crossbuild-essential-arm64 libc6-dev-i386' ;;
  arm64) architecture_deps='crossbuild-essential-amd64' ;;
  *) echo 'Unsupported gVisor build architecture' >&2; exit 1 ;;
esac
apt-get install -y --no-install-recommends \
  build-essential $architecture_deps \
  ca-certificates curl git python3 python3-setuptools \
  zip unzip patch diffutils pkg-config libffi-dev libssl-dev \
  clang libbpf-dev libnuma-dev erofs-utils busybox-static
apt-get clean
