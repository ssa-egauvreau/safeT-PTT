#!/bin/sh

# Xcode Cloud post-clone hook — repo-root delegator.
#
# Xcode Cloud searches for `ci_scripts` NEXT TO the Xcode project, which for this
# repo is ios-app/ (the project lives at ios-app/SafeTMobile.xcodeproj). The REAL
# hook therefore lives at ios-app/ci_scripts/ci_post_clone.sh. This repo-root
# copy exists only as insurance: if Xcode Cloud ever resolves `ci_scripts` from
# the repository root instead, it forwards to the real hook so generation still
# happens. Keep the two in sync by keeping all logic in the ios-app/ copy.

set -e
ROOT="${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$(dirname "$0")/.." && pwd)}"
echo "==> ci_post_clone (repo-root delegator) -> ios-app/ci_scripts/ci_post_clone.sh"
exec sh "$ROOT/ios-app/ci_scripts/ci_post_clone.sh"
