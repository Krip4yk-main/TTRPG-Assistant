#!/bin/bash
# Точка входу контейнера backup.
#   schedule       (за замовчуванням) — планувальник (BACKUP_ENABLED=false — простоює): бекап щодня о 03:30 UTC,
#                  перевірка відновлення щонеділі о 04:30 UTC.
#   backup         — разовий бекап зараз.
#   restore-check  — разова перевірка відновлення зараз.
set -euo pipefail

BIN_DIR="$(dirname "$0")"
# shellcheck source=backup-lib.sh
. "$BIN_DIR/backup-lib.sh"

BACKUP_AT=330        # 03:30 UTC (HHMM)
RESTORE_CHECK_AT=430 # 04:30 UTC, лише неділя

hhmm() { echo $((10#$(date -u +%H%M))); }

schedule() {
  # BACKUP_ENABLED=false (dev-сервер): без помилок і без перезапусків — просто чекаємо сигналу.
  if [ "${BACKUP_ENABLED:-true}" = "false" ]; then
    log "backups disabled (BACKUP_ENABLED=false): scheduler idle"
    trap 'log "scheduler stopped"; exit 0' TERM INT
    while true; do
      sleep 3600 &
      wait $! || true
    done
  fi
  # Fail closed одразу на старті, а не о 03:30.
  require_passphrase
  log "scheduler started: backup daily 03:30 UTC, restore-check Sundays 04:30 UTC"
  local last_backup="" last_check="" today
  trap 'log "scheduler stopped"; exit 0' TERM INT
  while true; do
    today="$(date -u +%Y-%m-%d)"
    # Бекап: раз на добу після 03:30. Якщо контейнер стартував пізніше і сьогоднішнього
    # бекапу ще немає — наздоганяємо одразу. Невдача не повторюється до наступної доби.
    if [ "$(hhmm)" -ge "$BACKUP_AT" ] && [ "$last_backup" != "$today" ]; then
      last_backup="$today"
      if find "$BACKUP_DIR" -maxdepth 1 -name "nri-${today}T*.sql.gz.enc" | grep -q .; then
        log "backup for $today already exists, skipping"
      elif ! "$BIN_DIR/backup.sh"; then
        log "ERROR: scheduled backup failed" >&2
      fi
    fi
    if [ "$(date -u +%u)" = "7" ] && [ "$(hhmm)" -ge "$RESTORE_CHECK_AT" ] \
      && [ "$last_check" != "$today" ]; then
      last_check="$today"
      if ! "$BIN_DIR/restore-check.sh"; then
        log "ERROR: scheduled restore-check failed" >&2
      fi
    fi
    sleep 30 &
    wait $! || true
  done
}

case "${1:-schedule}" in
  schedule) schedule ;;
  backup) exec "$BIN_DIR/backup.sh" ;;
  restore-check) exec "$BIN_DIR/restore-check.sh" ;;
  *) die "unknown command: $1 (use: schedule | backup | restore-check)" ;;
esac
