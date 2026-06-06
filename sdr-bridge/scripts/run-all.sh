#!/usr/bin/env bash
# One-shot launcher: Icecast + per-talkgroup streamers + trunk-recorder, together.
# Press Ctrl-C once to stop everything. Run from sdr-bridge/ AFTER `npm run generate`.
#
# Works the same inside WSL2 (Windows) or on native Linux.
set -uo pipefail
cd "$(dirname "$0")/.."   # -> sdr-bridge/

# Pull the latest talkgroups from the bridges you created in the SafeT console
# (Bridges -> Import from RadioReference) and regenerate the runtime files. Set
# SDR_SKIP_SYNC=1 to use a hand-built config (npm run generate) instead.
if [ "${SDR_SKIP_SYNC:-0}" != "1" ]; then
  echo "[sync] reading bridges from SafeT..."
  node scripts/sync-from-safet.mjs || {
    echo "  ! sync failed — falling back to existing generated files (or run 'npm run generate')." >&2
  }
fi

if [ ! -f icecast/icecast.xml ] || [ ! -f generated/stream-talkgroups.sh ]; then
  echo "  ✗ No runtime files yet. Create bridges in the console then re-run, or 'npm run generate'." >&2
  exit 1
fi

# Pick whichever Compose is installed: the v2 plugin (`docker compose`) or the
# standalone v1 binary (`docker-compose`).
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "  ✗ Docker Compose not found. Install it (Setup does this) and retry." >&2
  exit 1
fi

PIDS=()
cleanup() {
  echo
  echo "stopping..."
  # Stop trunk-recorder first, then the background helpers.
  $COMPOSE down >/dev/null 2>&1 || true
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
$COMPOSE up
