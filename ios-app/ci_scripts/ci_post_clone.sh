#!/bin/sh

# Xcode Cloud post-clone hook (the REAL implementation).
#
# LOCATION MATTERS: Xcode Cloud searches for the `ci_scripts` folder next to the
# Xcode project/workspace it builds. This project's Xcode project lives in
# `ios-app/`, so the hook has to be at ios-app/ci_scripts/ci_post_clone.sh. (A
# thin delegator at <repo-root>/ci_scripts/ci_post_clone.sh forwards here too,
# so the hook still runs if a future setup resolves ci_scripts from the repo
# root.)
#
# WHY THIS EXISTS
# ---------------
# ios-app/SafeTMobile.xcodeproj is generated from ios-app/project.yml by
# XcodeGen and is NOT committed (only the shared scheme is). On a fresh Xcode
# Cloud checkout the project must be generated before the build, or xcodebuild
# fails to read SafeTMobile.xcodeproj ("missing its project.pbxproj file").
#
# Xcode Cloud runs this after cloning + resolving submodules and BEFORE
# resolving packages / building.

set -e

echo "==> ci_post_clone: starting (pwd=$(pwd), CI_PRIMARY_REPOSITORY_PATH=${CI_PRIMARY_REPOSITORY_PATH:-<unset>}, CI_BUILD_NUMBER=${CI_BUILD_NUMBER:-<unset>})"

# Homebrew is preinstalled on Xcode Cloud runners. Put both the Apple Silicon
# (/opt/homebrew) and Intel (/usr/local) brew prefixes on PATH so brew and the
# freshly installed xcodegen are found.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_INSTALL_CLEANUP=1

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "==> installing xcodegen via Homebrew ($(command -v brew || echo 'brew NOT FOUND'))"
  brew install xcodegen
fi
echo "==> xcodegen: $(command -v xcodegen || echo 'NOT FOUND') $(xcodegen --version 2>/dev/null || true)"

# CI_PRIMARY_REPOSITORY_PATH is set by Xcode Cloud to the cloned repo root.
# Fall back to two-levels-up from this script (ios-app/ci_scripts -> repo root).
REPO_ROOT="${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$REPO_ROOT/ios-app"

# Stamp the Xcode Cloud build number into the (uncommitted) project version
# before generating, so each TestFlight upload gets a unique build number.
# Portable (no `sed -i`, which is BSD-only) and non-fatal (a missed stamp must
# never block project generation below).
if [ -n "${CI_BUILD_NUMBER:-}" ]; then
  echo "==> stamping CURRENT_PROJECT_VERSION = ${CI_BUILD_NUMBER}"
  if sed -E "s/(CURRENT_PROJECT_VERSION: )\"[0-9]+\"/\1\"${CI_BUILD_NUMBER}\"/" project.yml > project.yml.tmp; then
    mv project.yml.tmp project.yml
  else
    echo "==> warning: could not stamp build number; using project.yml default" >&2
    rm -f project.yml.tmp
  fi
fi

# setup.sh creates Local.xcconfig, ensures the native submodules (codec2, opus)
# are present, and runs `xcodegen generate`.
echo "==> running ios-app/setup.sh"
./setup.sh

# Verify generation actually produced the project file, with diagnostics, so a
# failure names itself HERE in the post-clone log instead of surfacing later as
# a confusing "missing project.pbxproj" at the archive step.
if [ ! -f "SafeTMobile.xcodeproj/project.pbxproj" ]; then
  echo "==> ERROR: xcodegen did not produce SafeTMobile.xcodeproj/project.pbxproj" >&2
  echo "==> ls -la $(pwd):" >&2; ls -la >&2 || true
  echo "==> ls -la SafeTMobile.xcodeproj:" >&2; ls -la SafeTMobile.xcodeproj >&2 || true
  exit 1
fi

echo "==> ci_post_clone: SafeTMobile.xcodeproj is ready"
