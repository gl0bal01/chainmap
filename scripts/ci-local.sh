#!/usr/bin/env bash
# Local mirror of .github/workflows/ci.yml — same steps, same order.
# Runs ALL steps even if one fails; exits non-zero if any failed.
# Add a CI step -> add it here too.
set -u
cd "$(dirname "$0")/.."

logdir=$(mktemp -d "${TMPDIR:-/tmp}/chainmap-ci.XXXXXX")
names=() results=()

step() { # step <name> <cmd...>
  local name=$1; shift
  echo "== $name =="
  if "$@" >"$logdir/$name.log" 2>&1; then results+=(PASS); else results+=(FAIL); fi
  names+=("$name")
}

step install bun install --frozen-lockfile
step test bun test
step vendor-integrity ./scripts/verify-vendor.sh

echo
printf '%-18s %-5s %s\n' STEP RESULT LOG
rc=0
for i in "${!names[@]}"; do
  printf '%-18s %-5s %s\n' "${names[$i]}" "${results[$i]}" "$logdir/${names[$i]}.log"
  [ "${results[$i]}" = PASS ] || rc=1
done
exit $rc
