#!/usr/bin/env bash
# One-shot launcher: Icecast + per-talkgroup streamers + trunk-recorder, together.
# Press Ctrl-C once to stop everything. Run from sdr-bridge/ AFTER `npm run generate`.
#
# Works the same inside WSL2 (Windows) or on native Linux.
set -uo pipefail
cd "$(dirname "$0")/.."   # -> sdr-bridge/

if [ ! -f icecast/icecast.xml ] || [ ! -f generated/stream-talkgroups.sh ]; then
  echo "  ✗ Missing generated files. Run:  npm run generate" >&2
  exit 1
fi

PIDS=()
cleanup() {
  echo
  echo "stopping..."
  # Stop trunk-recorder first, then the background helpers.
  docker compose down >/dev/null 2>&1 || true
  for pid in "${PIDS[@]:-}"; do kill "$pid" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT INT TERM

echo "[1/3] Icecast..."
icecast2 -c icecast/icecast.xml >/tmp/sdr-icecast.log 2>&1 &
PIDS+=($!)
sleep 2

echo "[2/3] talkgroup streamers (ffmpeg)..."
bash generated/stream-talkgroups.sh >/tmp/sdr-streamers.log 2>&1 &
PIDS+=($!)
sleep 1

echo "[3/3] trunk-recorder — decoding the system (Ctrl-C to stop everything)"
echo "      Icecast log:   /tmp/sdr-icecast.log"
echo "      Streamer log:  /tmp/sdr-streamers.log"
echo
# Foreground so you see the decoder lock the control channel and log calls.
docker compose up
