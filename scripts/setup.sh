#!/bin/sh
# One-time setup on the owner's machine: install the leak gate and wire the private
# dev notes into coding sessions. Safe to re-run.
set -eu
repo="$(git rev-parse --show-toplevel)"
cd "$repo"
git config core.hooksPath .githooks
echo "leak gate installed (core.hooksPath=.githooks)"
if [ -d private ] && [ ! -f CLAUDE.local.md ]; then
  printf '@private/CLAUDE.md\n' > CLAUDE.local.md
  echo "CLAUDE.local.md now imports private/CLAUDE.md"
fi
