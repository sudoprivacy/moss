#!/bin/sh
# moss-session-launch <session-id> -- <cmd...>
#
# Launches scode inside a per-user container. Records pid + start_ticks
# (USER_HZ clock ticks since boot) so the reaper can detect PID reuse before
# sending SIGKILL.
#
# setsid puts the scode tree in its own process group so kill -PGID can
# clean up forked children (bash, mcp, tmux) atomically.

set -e

if [ "$#" -lt 1 ]; then
  echo "usage: moss-session-launch <sid> -- <cmd...>" >&2
  exit 2
fi

SID="$1"
shift

if [ "${1:-}" != "--" ]; then
  echo "usage: moss-session-launch <sid> -- <cmd...>" >&2
  exit 2
fi
shift

RT_DIR="${MOSS_RUNTIME_DIR:-/data/runtime}"
META="$RT_DIR/sessions/$SID/runtime"
mkdir -p "$META"

echo "$SID" > "$META/scode.session_id"

# setsid establishes a new session/PGID. The inner shell records the pid
# (which is also PGID because of setsid) and start_ticks BEFORE exec, then
# replaces itself with scode. exec keeps the PID and starttime constant so
# the reaper's /proc/<pid>/stat field 22 (starttime in clock ticks since
# boot) matches what we just wrote here.
exec setsid sh -c '
  PID=$$
  echo "$PID" > "'"$META"'/scode.pid"
  awk "{print \$22}" "/proc/$PID/stat" > "'"$META"'/scode.start_ticks"
  exec "$@"
' _ "$@"
