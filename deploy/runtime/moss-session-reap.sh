#!/bin/sh
# moss-session-reap <session-id> [<grace-ms>]
#
# Kills the scode process group recorded by moss-session-launch. Uses the
# /proc/<pid>/stat field 22 (start_ticks in USER_HZ since boot) recorded at
# launch to guard against PID reuse — if the current process at that PID has
# a different start time, we skip the kill and only clear metadata. Same
# unit on both sides; do NOT mix with `date +%s%N` (wall clock, different
# epoch).

set -e

if [ "$#" -lt 1 ]; then
  echo "usage: moss-session-reap <sid> [grace-ms]" >&2
  exit 2
fi

SID="$1"
GRACE_MS="${2:-5000}"

RT_DIR="${MOSS_RUNTIME_DIR:-/data/runtime}"
META="$RT_DIR/sessions/$SID/runtime"
PIDFILE="$META/scode.pid"
TICKSFILE="$META/scode.start_ticks"

if [ ! -f "$PIDFILE" ]; then
  echo "no pidfile"
  exit 0
fi

PID=$(cat "$PIDFILE")

# Process already gone -> clear metadata, succeed.
if [ ! -r "/proc/$PID/stat" ]; then
  echo "pid $PID already gone"
  rm -f "$PIDFILE" "$TICKSFILE" "$META/scode.session_id"
  exit 0
fi

# PID reuse guard. Same source unit as the launcher.
if [ -r "$TICKSFILE" ]; then
  CUR_TICKS=$(awk '{print $22}' "/proc/$PID/stat")
  REC_TICKS=$(cat "$TICKSFILE")
  if [ "$CUR_TICKS" != "$REC_TICKS" ]; then
    echo "pid $PID start_ticks mismatch (cur=$CUR_TICKS rec=$REC_TICKS), skip kill"
    rm -f "$PIDFILE" "$TICKSFILE" "$META/scode.session_id"
    exit 0
  fi
fi

# Kill the process group. Leading `-` makes the target a PGID.
kill -TERM -- -"$PID" 2>/dev/null || true

if [ "$GRACE_MS" = "0" ]; then
  # Skip grace, jump to KILL immediately.
  kill -KILL -- -"$PID" 2>/dev/null || true
else
  SLEEP_S=$(awk -v ms="$GRACE_MS" 'BEGIN { print ms/1000 }')
  sleep "$SLEEP_S"
  if kill -0 "$PID" 2>/dev/null; then
    kill -KILL -- -"$PID" 2>/dev/null || true
  fi
fi

rm -f "$PIDFILE" "$TICKSFILE" "$META/scode.session_id"
