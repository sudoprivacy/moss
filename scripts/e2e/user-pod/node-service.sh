#!/bin/sh
# Keep container shims alive while the fixture restarts only the K3s service.
set -eu
# K3s performs this evacuation itself when it is PID 1. The scoped supervisor
# owns that role here, so its native child inherits the same empty-root layout.
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  [ "$(cat /proc/1/cgroup)" = '0::/' ]
  mkdir -p /sys/fs/cgroup/init
  printf '%s\n' "$$" > /sys/fs/cgroup/init/cgroup.procs
  for controller in $(cat /sys/fs/cgroup/cgroup.controllers); do
    printf '+%s\n' "$controller" > /sys/fs/cgroup/cgroup.subtree_control
  done
fi
child=''
stop() {
  rm -f /run/moss-k3s.restart
  [ -z "$child" ] || kill -TERM "$child" 2>/dev/null || true
  [ -z "$child" ] || wait "$child" || true
  exit 0
}
trap stop TERM INT
while :; do
  /bin/k3s "$@" &
  child=$!
  ticks="$(awk '{print $22}' "/proc/$child/stat")"
  printf '%s %s\n' "$child" "$ticks" > /run/moss-k3s.identity.new
  mv /run/moss-k3s.identity.new /run/moss-k3s.identity
  status=0
  wait "$child" || status=$?
  child=''
  [ -f /run/moss-k3s.restart ] || exit "$status"
  rm /run/moss-k3s.restart
done
