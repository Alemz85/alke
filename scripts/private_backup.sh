#!/bin/sh
# Back up the private root: commit everything in private/ (and the nested knowledge
# repo) and push both to their private remotes. Run with: npm run backup
set -eu
repo="$(git rev-parse --show-toplevel)"
priv="${ALKE_PRIVATE_ROOT:-$repo/private}"
backup() {
  dir="$1"
  [ -d "$dir/.git" ] || { echo "skip $dir (not a git repo)"; return 0; }
  git -C "$dir" add -A
  git -C "$dir" diff --cached --quiet || git -C "$dir" commit -q -m "backup $(date +%Y-%m-%d)"
  git -C "$dir" push -q
  echo "backed up $dir"
}
backup "$priv"
backup "$priv/knowledge"
