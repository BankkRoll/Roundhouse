#!/usr/bin/env bash
# Regenerates internal/api/testdata/openapi.json from the API source, for the
# contract test in internal/api/openapi_test.go. Run after changing API routes:
#
#   cli/scripts/gen-openapi.sh
#
# Needs Node and the repository's pnpm install.
set -euo pipefail

cli_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(cd "$cli_dir/.." && pwd)"
out="$cli_dir/internal/api/testdata/openapi.json"

tsx="$repo_dir/packages/protocol/node_modules/.bin/tsx"
if [ ! -x "$tsx" ]; then
  tsx="npx --yes tsx@4"
fi

cd "$repo_dir/apps/api"
# shellcheck disable=SC2086 # $tsx may be a command with arguments.
# Relative specifiers: Node rejects drive-letter paths in --import on Windows.
$tsx --import ../../cli/scripts/openapi/register.mjs ../../cli/scripts/openapi/dump.ts > "$out.tmp"
mv "$out.tmp" "$out"
echo "wrote $out"
