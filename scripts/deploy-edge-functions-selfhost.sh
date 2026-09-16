#!/usr/bin/env bash
# Deploy CARNO Edge Functions onto self-hosted Supabase (Docker).
# Run ON the DB host as root, from inside /opt/supabase-project (or set SUPABASE_ROOT).
#
# Usage:
#   cd /opt/supabase-project
#   bash /path/to/deploy-edge-functions-selfhost.sh
#
# Optional env:
#   SUPABASE_ROOT=/opt/supabase-project
#   REPO_DIR=/tmp/campaign-management   # if already cloned
#   SKIP_MIGRATE=1
#   SKIP_RESTART=1

set -euo pipefail

SUPABASE_ROOT="${SUPABASE_ROOT:-/opt/supabase-project}"
FUNCTIONS_DST="${SUPABASE_ROOT}/volumes/functions"
REPO_URL="${REPO_URL:-https://github.com/mahdihoseini4business-art/campaign-management.git}"
REPO_REF="${REPO_REF:-main}"

if [[ ! -d "$SUPABASE_ROOT" ]]; then
  echo "ERROR: SUPABASE_ROOT not found: $SUPABASE_ROOT" >&2
  exit 1
fi

if [[ ! -d "$FUNCTIONS_DST" ]]; then
  echo "ERROR: functions volume missing: $FUNCTIONS_DST" >&2
  echo "Expected self-hosted layout with volumes/functions" >&2
  exit 1
fi

WORKDIR="${REPO_DIR:-}"
CLEANUP_WORKDIR=0
if [[ -z "$WORKDIR" ]]; then
  WORKDIR="$(mktemp -d /tmp/carno-fn-XXXXXX)"
  CLEANUP_WORKDIR=1
  echo "==> Cloning $REPO_URL ($REPO_REF) → $WORKDIR"
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$WORKDIR"
elif [[ ! -d "$WORKDIR/supabase/functions" ]]; then
  echo "ERROR: REPO_DIR has no supabase/functions: $WORKDIR" >&2
  exit 1
fi

SRC="$WORKDIR/supabase/functions"

# Portable sync without rsync (many minimal servers lack it)
sync_dir() {
  local from="$1"
  local to="$2"
  mkdir -p "$to"
  # wipe managed contents then copy (keeps destination root)
  find "$to" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  # copy including hidden files
  shopt -s dotglob nullglob
  local items=("$from"/*)
  if ((${#items[@]})); then
    cp -a "${items[@]}" "$to/"
  fi
  shopt -u dotglob nullglob
}

# Functions shipped by this app (skip hello/main provided by supabase docker)
FUNCS=(
  send-otp
  verify-otp
  platform-api
  tenant-api
  tenant-ops
  create-payment
  zarinpal-callback
  subscription-cron
  ops-digest-cron
  send-sms
  sms-schedule-cron
)

echo "==> Syncing shared helpers"
if [[ -d "$SRC/_shared" ]]; then
  sync_dir "$SRC/_shared" "$FUNCTIONS_DST/_shared"
fi

echo "==> Syncing edge functions → $FUNCTIONS_DST"
for name in "${FUNCS[@]}"; do
  if [[ ! -d "$SRC/$name" ]]; then
    echo "  skip missing: $name"
    continue
  fi
  echo "  → $name"
  sync_dir "$SRC/$name" "$FUNCTIONS_DST/$name"
done

# Ensure Deno can resolve relative ../_shared imports from each function dir
# (layout: volumes/functions/<fn>/index.ts and volumes/functions/_shared/)

if [[ "${SKIP_MIGRATE:-0}" != "1" ]]; then
  MIG="$WORKDIR/supabase/migrations/044_sms_business.sql"
  if [[ -f "$MIG" ]]; then
    echo "==> Applying migration 044_sms_business.sql (if not already applied)"
    # Prefer docker exec into db container — names vary
    DB_CID="$(docker ps --filter name=supabase-db --format '{{.ID}}' | head -1 || true)"
    if [[ -z "$DB_CID" ]]; then
      DB_CID="$(docker ps --filter name=db --format '{{.ID}}' | head -1 || true)"
    fi
    if [[ -n "$DB_CID" ]]; then
      # Record in supabase_migrations.schema_migrations if table exists; else just run SQL
      docker exec -i "$DB_CID" psql -U postgres -d postgres < "$MIG" \
        && echo "  migration SQL executed" \
        || echo "  WARN: migration failed (may already be applied) — check output above"
    else
      echo "  WARN: could not find supabase-db container; apply $MIG manually"
    fi
  fi
fi

if [[ "${SKIP_RESTART:-0}" != "1" ]]; then
  echo "==> Restarting edge functions container"
  cd "$SUPABASE_ROOT"
  if [[ -x ./run.sh ]]; then
    sh ./run.sh restart functions || docker compose restart functions
  elif docker compose ps functions >/dev/null 2>&1; then
    docker compose restart functions
  else
    # fallback by container name
    docker restart supabase-edge-functions 2>/dev/null \
      || docker restart "$(docker ps --filter name=edge-functions --format '{{.ID}}' | head -1)"
  fi
fi

echo
echo "==> Deployed. Smoke (replace ANON_KEY):"
echo "  curl -sS -X POST http://127.0.0.1:8000/functions/v1/send-sms \\"
echo "    -H \"apikey: \$ANON_KEY\" -H \"Authorization: Bearer \$ANON_KEY\" \\"
echo "    -H 'Content-Type: application/json' -d '{\"kind\":\"sale_single\"}'"
echo
echo "==> Reminders:"
echo "  1) Ensure SMS_* and CRON_SECRET are in functions env (.env / docker-compose), then:"
echo "       sh run.sh recreate functions"
echo "  2) Cron every 5 min for sms-schedule-cron with header x-cron-secret"
echo "  3) Grant SMS permissions + toggle features in app settings"

if [[ "$CLEANUP_WORKDIR" == "1" ]]; then
  rm -rf "$WORKDIR"
fi

echo "Done."
