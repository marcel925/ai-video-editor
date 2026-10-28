#!/usr/bin/env bash
# Step 0 of every edit: pull the latest skills and tools from GitHub, so a
# change made from another machine or session is in before anything renders.
#
#   bash tools/update.sh
#
# - Not a git clone (a plugin install): says so and exits 0; plugins update
#   with /plugin.
# - Offline or no upstream: warns and exits 0 - edit with what is here.
# - Behind: fast-forwards (`git pull --ff-only --autostash`), keeping local
#   uncommitted edits. Refuses, exit 2, when an incoming commit touches a file
#   that also has local edits, or local and remote have diverged: then the
#   user decides (commit, stash or merge) - never discard their changes.
# - Re-installs the motion packages when motion/package*.json changed, and
#   says to re-run tools/setup.sh when setup.sh changed.
set -u
cd "$(dirname "$0")/.." || exit 1

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "update: not a git clone (plugin install) - update with /plugin, skipping"
  exit 0
fi
if ! git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  echo "update: branch $(git branch --show-current) has no upstream - skipping"
  exit 0
fi
if ! git fetch --quiet 2>/dev/null; then
  echo "update: could not reach GitHub - editing with the local copy"
  exit 0
fi

behind=$(git rev-list --count 'HEAD..@{u}')
ahead=$(git rev-list --count '@{u}..HEAD')
if [ "$behind" -eq 0 ]; then
  echo "update: up to date with $(git rev-parse --abbrev-ref '@{u}')"
  exit 0
fi
if [ "$ahead" -gt 0 ]; then
  echo "update: local branch has $ahead commit(s) GitHub does not and is $behind behind - merge or rebase by hand"
  exit 2
fi

incoming=$(git diff --name-only HEAD '@{u}')
local_edits=$( { git diff --name-only; git diff --name-only --cached; } | sort -u)
clash=$(comm -12 <(echo "$incoming" | sort -u) <(echo "$local_edits"))
if [ -n "$clash" ]; then
  echo "update: $behind new commit(s) on GitHub change files that also have local edits:"
  echo "$clash" | sed 's/^/  /'
  echo "commit or stash them, then run this again"
  exit 2
fi

if ! git pull --ff-only --autostash --quiet; then
  echo "update: git pull failed - see above"
  exit 2
fi
echo "update: pulled $behind commit(s):"
git log --oneline "HEAD~$behind..HEAD" | sed 's/^/  /'

if echo "$incoming" | grep -q '^motion/package'; then
  echo "update: motion packages changed - installing"
  (cd motion && npm install --silent) || echo "update: npm install failed - run it in motion/"
fi
if echo "$incoming" | grep -q '^tools/setup.sh'; then
  echo "update: tools/setup.sh changed - re-run it before rendering"
fi
exit 0
