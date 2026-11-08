#!/usr/bin/env bash
# Daily Vault backup on a Linux host. Suggested cron:
#   30 3 * * * /opt/vault/app/deploy/vault/linux/backup.sh >> /var/log/vault-backup.log 2>&1
set -euo pipefail
APP_DIR="${VAULT_APP_DIR:-/opt/vault/app}"
BACKUP_ROOT="${VAULT_BACKUP_DIR:-/var/lib/vault/backup}"
KEEP="${VAULT_BACKUP_KEEP:-14}"
ENV_FILE="${VAULT_ENV_FILE:-/etc/vault/vault.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
mkdir -p "$BACKUP_ROOT"
node "$APP_DIR/scripts/vault-backup.mjs" --out "$BACKUP_ROOT" --label daily --pg-dump
# retention: keep newest $KEEP directories
ls -1dt "$BACKUP_ROOT"/vault-* 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -rf
echo "backup ok: $(ls -1dt "$BACKUP_ROOT"/vault-* 2>/dev/null | head -n 1)"
