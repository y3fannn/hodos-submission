#!/usr/bin/env bash
# The VM pulls its own code. Nothing pushes to the VM, and the VM cannot push anywhere.
# It moves only to a tag named deploy-*, which goes only on a commit whose CI passed.
# Runs as finagent, every 10 minutes, from finagent-deploy.timer.
# design/2026-09-20-vm.md step 11.
set -euo pipefail

APP=/opt/finagent/app
WEB="$APP/webapp"
STATE=/opt/finagent/deployed-tag
HEALTH=http://127.0.0.1:8787/api/auth/status

cd "$APP"
git fetch --quiet --tags --prune --prune-tags origin

# Newest by NAME, not by date. A lightweight tag carries its commit's date, so sorting by date
# ties when two tags sit on one commit, and — worse — a rollback tag put on an older commit would
# look older than the broken one and never be taken. The name is the version: deploy-YYYYMMDD-N.
want=$(git tag -l 'deploy-*' --sort=-version:refname | head -1)
[ -n "$want" ] || { echo "no deploy-* tag yet; nothing to do"; exit 0; }

have=$(cat "$STATE" 2>/dev/null || echo "")
[ "$want" = "$have" ] && exit 0

echo "deploying $want (was ${have:-nothing})"
git checkout --quiet --force "$want"
npm --prefix "$WEB" ci --omit=dev --silent

sudo /usr/bin/systemctl restart finagent

for i in $(seq 1 20); do
  sleep 1
  if curl -fsS --max-time 3 "$HEALTH" >/dev/null 2>&1; then
    echo "$want" > "$STATE"
    echo "deployed $want"
    exit 0
  fi
done

echo "health check failed after $want; rolling back" >&2
if [ -z "$have" ]; then
  echo "nothing to roll back to: this was the first deploy. The app is down." >&2
  exit 1
fi

git checkout --quiet --force "$have"
npm --prefix "$WEB" ci --omit=dev --silent
sudo /usr/bin/systemctl restart finagent

# The rollback is checked too. A rollback that also fails to answer is the worst case, and it must
# be said out loud rather than reported as recovered.
for i in $(seq 1 20); do
  sleep 1
  if curl -fsS --max-time 3 "$HEALTH" >/dev/null 2>&1; then
    echo "rolled back to $have, and it is answering" >&2
    exit 1
  fi
done
echo "ROLLED BACK to $have AND IT IS STILL NOT ANSWERING. The app is down." >&2
exit 1
