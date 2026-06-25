#!/bin/sh

# Xcode Cloud post-clone hook.
#
# WHY THIS EXISTS
# ---------------
# ios-app/SafeTMobile.xcodeproj is NOT committed — it is generated from
# ios-app/project.yml by XcodeGen (see ios-app/.gitignore and ios-app/setup.sh).
# Xcode Cloud clones a fresh, project-less checkout, so without this hook the
# build dies at the "Resolve package dependencies" step with:
#
#   xcodebuild: error: '/Volumes/workspace/repository/ios-app/SafeTMobile.xcodeproj' does not exist.
#
# Xcode Cloud automatically runs this script after cloning the repo and its
# submodules and BEFORE resolving packages / building. It MUST live at
# <repo-root>/ci_scripts/ci_post_clone.sh and be executable (chmod +x).
#
# This mirrors the GitHub Actions path (.github/workflows/ios-testflight.yml):
# install XcodeGen, then run ios-app/setup.sh to generate the project.

set -e

echo "==> ci_post_clone: generating SafeTMobile.xcodeproj with XcodeGen"

# Homebrew is preinstalled on Xcode Cloud runners. Put both the Apple Silicon
# (/opt/homebrew) and Intel (/usr/local) brew prefixes on PATH so the freshly
# installed `xcodegen` binary is found below.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Faster, quieter installs in CI.
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_INSTALL_CLEANUP=1

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "==> installing xcodegen via Homebrew"
  brew install xcodegen
fi

# CI_PRIMARY_REPOSITORY_PATH is set by Xcode Cloud to the cloned repo root.
# Fall back to a path relative to this script so the hook also works locally.
REPO_ROOT="${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$(dirname "$0")/.." && pwd)}"

cd "$REPO_ROOT/ios-app"

# setup.sh copies Local.example.xcconfig -> Local.xcconfig, ensures the native
# submodules (codec2, opus) are present, and runs `xcodegen generate`. Xcode
# Cloud has already resolved the submodules, so setup.sh just regenerates the
# project + Info.plist.
./setup.sh

echo "==> ci_post_clone: SafeTMobile.xcodeproj is ready"
