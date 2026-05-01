#!/usr/bin/env bash
# scripts/sync-vendor-ilink.sh
#
# Sync helper for the vendored Tencent/openclaw-weixin protocol code at
# `packages/im-wechat/lib/ilink/`. NEVER modifies the working tree — output is
# diff + advice only; the human operator decides which upstream changes to pull.
#
# DD: docs/superpowers/specs/2026-04-26-ilink-library-dd.md
# Vendor docs: packages/im-wechat/lib/ilink/VENDOR.md
#
# Usage:
#   ./scripts/sync-vendor-ilink.sh [TARGET_REF]
# Default TARGET_REF: origin/main of the upstream tree (latest unreleased).
# Set TARGET_REF to a tag (e.g. v2.1.8) or commit SHA to compare against that
# revision instead.

set -euo pipefail

UPSTREAM_REPO="https://github.com/Tencent/openclaw-weixin.git"
PINNED_COMMIT="6e58a2bcb505df2cad8ba396b8b58b18bbcb5777"  # v2.1.7, 2026-04-07

# Subdirs we vendor — keep in sync with `lib/ilink/VENDOR.md` Contents.
# `monitor/` intentionally omitted (rewritten as EventEmitter-style pump in src/).
VENDORED_SUBDIRS=(
  "src/api"
  "src/auth"
  "src/cdn"
  "src/messaging"
  "src/media"
  "src/util"
  "src/storage"
  "src/config"
)

# Files we know we've patched locally — sync must preserve these patches or
# operator must manually re-apply / re-evaluate after upstream merge.
LOCAL_PATCHED_FILES=(
  "lib/ilink/auth/accounts.ts"            # full rewrite to minimal exports
  "lib/ilink/auth/pairing.ts"             # openclaw import → shim path
  "lib/ilink/auth/pairing.test.ts"        # vi.mock subpath
  "lib/ilink/messaging/send.ts"           # openclaw import → shim path
  "lib/ilink/util/logger.ts"              # openclaw import + LEVEL_IDS literal-keyed
  "lib/ilink/media/mime.ts"               # split[0] ?? "" narrowing
  "lib/ilink/messaging/process-message.ts"  # DELETED (channelRuntime coupling)
)

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

TARGET_REF="${1:-origin/main}"

echo "==> Cloning upstream ${UPSTREAM_REPO}"
git clone --quiet --filter=blob:none "$UPSTREAM_REPO" "$WORK_DIR/upstream"
cd "$WORK_DIR/upstream"

echo "==> Resolving target commit (ref: $TARGET_REF)"
TARGET_COMMIT="$(git rev-parse "$TARGET_REF")"
echo "    pinned : $PINNED_COMMIT"
echo "    target : $TARGET_COMMIT"
if [ "$TARGET_COMMIT" = "$PINNED_COMMIT" ]; then
  echo "==> Already at pinned commit — nothing to do."
  exit 0
fi

echo
echo "==> Commits between pinned and target ($PINNED_COMMIT..$TARGET_COMMIT):"
git log --oneline --no-decorate "${PINNED_COMMIT}..${TARGET_COMMIT}" || true

echo
echo "==> Files changed in vendored subdirs:"
git diff --name-only "${PINNED_COMMIT}" "${TARGET_COMMIT}" -- "${VENDORED_SUBDIRS[@]}" | sort -u | tee "$WORK_DIR/changed.txt"

echo
echo "==> Locally patched files affected by this upstream diff:"
LOCAL_HITS=0
while IFS= read -r upstream_file; do
  # Map upstream `src/<subdir>/<file>` → vendored `lib/ilink/<subdir>/<file>`.
  vendored_path="lib/ilink/${upstream_file#src/}"
  for patched in "${LOCAL_PATCHED_FILES[@]}"; do
    if [ "$patched" = "$vendored_path" ]; then
      echo "  ⚠️  $vendored_path  ← upstream changed AND we have local patches; manual merge required"
      LOCAL_HITS=$((LOCAL_HITS + 1))
    fi
  done
done < "$WORK_DIR/changed.txt"
if [ "$LOCAL_HITS" -eq 0 ]; then
  echo "  (none — upstream changes are in files we vendor as-is)"
fi

echo
echo "==> Diff per vendored subdir (full patches):"
for subdir in "${VENDORED_SUBDIRS[@]}"; do
  if git diff --quiet "${PINNED_COMMIT}" "${TARGET_COMMIT}" -- "$subdir"; then
    continue
  fi
  echo
  echo "----- $subdir -----"
  git diff "${PINNED_COMMIT}" "${TARGET_COMMIT}" -- "$subdir"
done

echo
echo "==> Next steps (manual):"
echo "  1) Review the diff above. Cherry-pick relevant fixes into "
echo "     packages/im-wechat/lib/ilink/ (preserve our 7 local patches)."
echo "  2) Update PINNED_COMMIT in this script + lib/ilink/VENDOR.md."
echo "  3) cd packages/im-wechat && pnpm typecheck && pnpm exec vitest run"
echo "  4) Commit with message: 'chore(im-wechat): sync openclaw-weixin → <ref>'"
