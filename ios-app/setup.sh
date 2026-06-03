#!/usr/bin/env bash
# safeT PTT iOS — bootstrap after clone OR after every `git pull`.
#
# 1. Ensures git submodules (codec2, opus) are present — the #1 cause of
#    "Clean Build Folder then build fails" is empty submodule folders.
# 2. Creates Local.xcconfig from the template (if missing).
# 3. Regenerates SafeTMobile.xcodeproj + SafeTMobile/Info.plist via XcodeGen.
#
# Run from ios-app:  ./setup.sh
# Safe to run repeatedly.

set -euo pipefail

cd "$(dirname "$0")"
REPO_ROOT="$(cd .. && pwd)"

require_file() {
  if [ ! -f "$1" ]; then
    echo "missing: $1" >&2
    return 1
  fi
  return 0
}

if [ ! -f Local.xcconfig ]; then
  cp Local.example.xcconfig Local.xcconfig
  echo "Created ios-app/Local.xcconfig from the template."
  echo "Edit SAFET_API_BASE_URL (see Local.example.xcconfig), then run ./setup.sh again."
fi

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen not found. Install it with:  brew install xcodegen" >&2
  exit 1
fi

CODEC2_HDR="${REPO_ROOT}/android-app/app/src/main/cpp/codec2/src/codec2.h"
OPUS_HDR="${REPO_ROOT}/android-app/app/src/main/cpp/opus/include/opus.h"
DVM_DIR="${REPO_ROOT}/android-app/app/src/main/cpp/dvmvocoder/vocoder"

missing_deps=0
require_file "$CODEC2_HDR" || missing_deps=1
require_file "$OPUS_HDR" || missing_deps=1
if [ ! -d "$DVM_DIR" ]; then
  echo "missing: $DVM_DIR" >&2
  missing_deps=1
fi

if [ "$missing_deps" -ne 0 ]; then
  if [ ! -f "${REPO_ROOT}/.gitmodules" ]; then
    echo "Native voice libraries are missing and this is not a git checkout." >&2
    echo "You need the full safeT-PTT repo (with android-app/cpp submodules)." >&2
    exit 1
  fi
  echo "Fetching git submodules (codec2, opus) — required for iOS native build…"
  (cd "$REPO_ROOT" && git submodule update --init --recursive)
fi

require_file "$CODEC2_HDR"
require_file "$OPUS_HDR"

xcodegen generate

require_file "SafeTMobile/Info.plist"
require_file "SafeTMobile.xcodeproj/project.pbxproj"

echo ""
echo "OK — iOS project is ready."
echo "  • Open SafeTMobile.xcodeproj in Xcode"
echo "  • Product → Build (⌘B). Only use Clean Build Folder if Xcode still shows stale errors."
echo "  • After every git pull: run ./setup.sh from ios-app before building."
