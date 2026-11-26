#!/bin/bash
# Перевірка відновлення: останній локальний бекап → тимчасова БД nri_restore_check на тому ж MySQL,
# порівняння кількості рядків ключових таблиць із живою БД, друк OK/FAIL.
# Тимчасова БД видаляється на виході (trap). Ненульовий код при FAIL.
# Документація: docs/ops/backups.md. `set -x` тут заборонено.
set -euo pipefail

# shellcheck source=backup-lib.sh
. "$(dirname "$0")/backup-lib.sh"

# Назва фіксована навмисно: скрипт видаляє цю БД, тож її не можна перевизначити ззовні.
RESTORE_DB=nri_restore_check
TABLES="users games game_members game_sessions notifications"

require_passphrase
make_mysql_cnf

created_db=0
cleanup() {
  if [ "$created_db" = 1 ]; then
    if mysql --defaults-extra-file="$MYSQL_CNF" -e "DROP DATABASE IF EXISTS \`$RESTORE_DB\`"; then
      log "temporary database $RESTORE_DB dropped"
    else
      log "ERROR: failed to drop temporary database $RESTORE_DB" >&2
    fi
  fi
  cleanup_work_dir
}
trap cleanup EXIT

sql() { mysql --defaults-extra-file="$MYSQL_CNF" -N -B -e "$1"; }

BACKUP_FILE="$(latest_backup)"
if [ -z "$BACKUP_FILE" ]; then
  log "restore-check FAIL: no backups found in $BACKUP_DIR"
  exit 1
fi
log "restore-check started: $(basename "$BACKUP_FILE")"

created_db=1
sql "DROP DATABASE IF EXISTS \`$RESTORE_DB\`"
sql "CREATE DATABASE \`$RESTORE_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

# DEFINER прибираємо: інакше користувач backup мав би мати SET_ANY_DEFINER.
# shellcheck disable=SC2016 # бектики тут — літерали SQL, не підстановка
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE -in "$BACKUP_FILE" \
  | gzip -dc \
  | sed -E 's/DEFINER=`[^`]*`@`[^`]*`//g' \
  | mysql --defaults-extra-file="$MYSQL_CNF" "$RESTORE_DB" \
  || { log "restore-check FAIL: could not decrypt or restore $(basename "$BACKUP_FILE")"; exit 1; }
log "restored into $RESTORE_DB"

# Допуск: ±1 % від живої кількості, але щонайменше ±5 рядків (для малих таблиць).
# Жива БД змінюється після бекапу, тому точного збігу не вимагаємо.
status=OK
for t in $TABLES; do
  live="$(sql "SELECT COUNT(*) FROM \`$BACKUP_DB_NAME\`.\`$t\`")" || { live=""; }
  restored="$(sql "SELECT COUNT(*) FROM \`$RESTORE_DB\`.\`$t\`")" || { restored=""; }
  if [ -z "$live" ] || [ -z "$restored" ]; then
    log "  $t: FAIL (table missing: live='${live}' restored='${restored}')"
    status=FAIL
    continue
  fi
  tol=$((live / 100))
  [ "$tol" -lt 5 ] && tol=5
  diff=$((live - restored))
  [ "$diff" -lt 0 ] && diff=$((-diff))
  if [ "$diff" -le "$tol" ]; then
    log "  $t: OK (live=$live restored=$restored tolerance=$tol)"
  else
    log "  $t: FAIL (live=$live restored=$restored tolerance=$tol)"
    status=FAIL
  fi
done

log "restore-check $status"
[ "$status" = OK ]
