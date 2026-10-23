#!/usr/bin/env bash
set -euo pipefail
validation=/var/tmp/secretary-linux-validation
source_dir="$(cd "$(dirname "$0")/.." && pwd)"
cp "$source_dir/scripts/performance.ts" "$validation/service/scripts/performance.ts"
mkdir -p "$source_dir/docs/evidence"
cd "$validation/service"
systemd-run --user --scope -p MemoryMax=2G -p CPUQuota=200% -p AllowedCPUs=0,1 \
  env SECRETARY_PERFORMANCE_REPORT="$source_dir/docs/evidence/performance-linux-2c-2g.json" \
  "$validation/node-v24.11.0-linux-x64/bin/node" node_modules/tsx/dist/cli.mjs scripts/performance.ts
