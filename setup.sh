#!/usr/bin/env bash
#
# Builds the upstream library this adapter depends on, and installs the skill.
#
# The npm package named in upstream's README is not published to the registry
# (`npm install fast-jev-compaction` returns 404), so the source is cloned and
# built here instead.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

UPSTREAM="https://github.com/tamaratran/fast-jev-compaction.git"
SKILL_DIR="${HERMES_HOME:-$HOME/.hermes}/skills/agent-infra/jev-compaction"

echo "==> Node"
node --version

echo
echo "==> Upstream library"
if [ -d src-repo/.git ]; then
  echo "    already cloned, fetching latest"
  git -C src-repo fetch --depth 1 origin main
  git -C src-repo reset --hard origin/main
else
  git clone --depth 1 "$UPSTREAM" src-repo
fi

echo
echo "==> Building upstream"
(cd src-repo && npm install --silent && npm run build)

if [ ! -f src-repo/dist/index.js ]; then
  echo "    BUILD FAILED: src-repo/dist/index.js is missing" >&2
  exit 1
fi

echo
echo "==> Installing the skill"
mkdir -p "$SKILL_DIR"
cp SKILL.md "$SKILL_DIR/SKILL.md"
echo "    $SKILL_DIR/SKILL.md"

echo
echo "==> Verifying the adapter can load upstream"
node -e "
import('./src-repo/dist/index.js').then((m) => {
  const need = ['compactMessages', 'collectToolCalls', 'reductionRatio'];
  const missing = need.filter((n) => typeof m[n] !== 'function');
  if (missing.length) {
    console.error('    MISSING EXPORTS:', missing.join(', '));
    process.exit(1);
  }
  console.log('    exports OK:', need.join(', '));
}).catch((err) => {
  console.error('    FAILED:', err.message);
  process.exit(1);
});
"

echo
echo "Done."
echo
echo "Next:"
echo "  export TYPESAFE_API_KEY=...    # https://console.typesafe.ai/"
echo "  node hermes-compact.mjs ~/.hermes/sessions/session_<id>.json   # dry run"
