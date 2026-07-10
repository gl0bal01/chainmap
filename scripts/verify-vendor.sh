#!/usr/bin/env bash
# =============================================================================
# verify-vendor.sh — assert the vendored libraries are EXACTLY the pinned bytes.
#
# Two independent checks (fails non-zero on any mismatch):
#   1) SHA-256 of each file matches vendor/VENDOR.md.
#   2) The SRI sha384 in every <script src="vendor/..."> in index.html matches a
#      freshly computed hash of the file (and no vendored script lacks integrity).
#
# Run locally before committing a vendor upgrade; also runs in CI. If you bump a
# vendored file, update BOTH VENDOR.md and the index.html integrity= attribute —
# a stale SRI hash makes the browser refuse to load the library for every user.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== SHA-256 (vendor/VENDOR.md) =="
grep -E '^[0-9a-f]{64}  vendor/' vendor/VENDOR.md | sha256sum -c -

echo
echo "== SRI sha384 (index.html) =="
tags=$(grep -oE '<script[^>]*src="vendor/[^"]+"[^>]*>' index.html || true)
[ -n "$tags" ] || { echo "ERROR: no vendored <script> tags found in index.html"; exit 1; }

fail=0
while IFS= read -r tag; do
  src=$(printf '%s' "$tag" | grep -oE 'src="vendor/[^"]+"' | sed -E 's/src="([^"]+)"/\1/')
  hash=$(printf '%s' "$tag" | grep -oE 'integrity="sha384-[^"]+"' | sed -E 's/integrity="([^"]+)"/\1/' || true)
  if [ -z "$hash" ]; then
    echo "FAIL $src — missing integrity attribute"
    fail=1
    continue
  fi
  actual="sha384-$(openssl dgst -sha384 -binary "$src" | openssl base64 -A)"
  if [ "$actual" = "$hash" ]; then
    echo "OK   $src"
  else
    echo "FAIL $src"
    echo "     index.html: $hash"
    echo "     actual:     $actual"
    fail=1
  fi
done <<< "$tags"

exit "$fail"
