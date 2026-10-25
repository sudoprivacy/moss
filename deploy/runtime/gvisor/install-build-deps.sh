#!/bin/sh
set -eu

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  build-essential crossbuild-essential-arm64 libc6-dev-i386 \
  ca-certificates curl git python3 python3-setuptools \
  zip unzip patch diffutils pkg-config libffi-dev libssl-dev \
  clang libbpf-dev libnuma-dev erofs-utils busybox-static
apt-get clean
