#!/usr/bin/env bash
# web/ is the single source of truth for the UI. This copies it into the Android and iOS apps
# (dropping the PWA-only <link data-pwa> tags, which don't exist inside the native bundles).
#   scripts/sync.sh          copy files
#   scripts/sync.sh --check  exit 1 if the native copies are out of date (used by CI)
set -euo pipefail
cd "$(dirname "$0")/.."
TARGETS=(android/app/src/main/assets ios)
FILES=(index.html core.js)
status=0
for dir in "${TARGETS[@]}"; do
  mkdir -p "$dir"
  for f in "${FILES[@]}"; do
    tmp="$(mktemp)"
    grep -v 'data-pwa' "web/$f" > "$tmp"
    if [[ "${1:-}" == "--check" ]]; then
      cmp -s "$tmp" "$dir/$f" || { echo "OUT OF DATE: $dir/$f (run scripts/sync.sh)"; status=1; }
      rm -f "$tmp"
    else
      mv "$tmp" "$dir/$f"; echo "synced $dir/$f"
    fi
  done
done
exit $status
