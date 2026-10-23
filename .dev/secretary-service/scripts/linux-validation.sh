#!/usr/bin/env bash
set -euo pipefail
# Isolated local validation; does not replace the host Node or copy any private vault.
validation=/var/tmp/secretary-linux-validation
source_dir="$(cd "$(dirname "$0")/.." && pwd)"
tools="$source_dir/.runtime/linux-tools"
mkdir -p "$tools" "$validation"
if [ ! -x "$validation/node-v24.11.0-linux-x64/bin/node" ]; then
  if [ ! -f "$tools/SHASUMS256.txt" ]; then curl --silent --show-error --fail --location --retry 2 --retry-all-errors --connect-timeout 10 --max-time 30 -o "$tools/SHASUMS256.txt" https://nodejs.org/dist/v24.11.0/SHASUMS256.txt; fi
  if [ ! -f "$tools/node-v24.11.0-linux-x64.tar.xz" ]; then
    curl --silent --show-error --fail --location --retry 2 --retry-all-errors --connect-timeout 10 --max-time 180 -o "$tools/node-v24.11.0-linux-x64.tar.xz.partial" https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-x64.tar.xz
    mv "$tools/node-v24.11.0-linux-x64.tar.xz.partial" "$tools/node-v24.11.0-linux-x64.tar.xz"
  fi
  (cd "$tools" && sha256sum --check --ignore-missing SHASUMS256.txt)
  tar -xm -C "$validation" -f "$tools/node-v24.11.0-linux-x64.tar.xz"
fi
export PATH="$validation/node-v24.11.0-linux-x64/bin:$PATH"
node --version
test "$(node -p 'process.versions.node.split(".")[0]')" = 24
mkdir -p "$validation/service"
tar -C "$source_dir" --exclude=node_modules --exclude=.runtime --exclude=test-results --exclude=playwright-report -cf "$validation/service.tar" .
tar -C "$validation/service" -xf "$validation/service.tar"
cd "$validation/service"
npm ci --registry=https://registry.npmjs.org --fetch-retries=2 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=10000 --fetch-timeout=60000 --no-audit --no-fund
npm test
SECRETARY_PERFORMANCE_REPORT="$validation/performance.json" npm exec -- tsx scripts/performance.ts
