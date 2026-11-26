#!/bin/bash
# Спільні функції для backup.sh і restore-check.sh. Підключається через `source`.
# Секрети (паролі, ключі) ніколи не передаються аргументами команд і не друкуються.

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_DB_HOST="${BACKUP_DB_HOST:-mysql}"
BACKUP_DB_PORT="${BACKUP_DB_PORT:-3306}"
BACKUP_DB_USER="${BACKUP_DB_USER:-backup}"
BACKUP_DB_NAME="${BACKUP_DB_NAME:-nri}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

# Fail closed: без парольної фрази нічого не шифруємо й не розшифровуємо.
require_passphrase() {
  if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
    die "BACKUP_PASSPHRASE is not set — refusing to run (backups are never stored unencrypted)"
  fi
  export BACKUP_PASSPHRASE
}

# Створює option-файл MySQL (права 600) у приватному тимчасовому каталозі.
# TMPDIR у контейнері — tmpfs (/tmp), тож пароль не потрапляє на диск.
# Результат: змінні WORK_DIR і MYSQL_CNF. Прибирання — cleanup_work_dir (у trap).
make_mysql_cnf() {
  if [ -z "${BACKUP_DB_PASSWORD:-}" ]; then
    die "BACKUP_DB_PASSWORD is not set"
  fi
  case "$BACKUP_DB_PASSWORD" in
    *'"'* | *\\* | *$'\n'*)
      die 'BACKUP_DB_PASSWORD must not contain double quotes, backslashes or newlines' ;;
  esac
  WORK_DIR="$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/nri-backup.XXXXXX")"
  MYSQL_CNF="$WORK_DIR/client.cnf"
  (
    umask 077
    printf '[client]\nhost=%s\nport=%s\nuser=%s\npassword="%s"\n' \
      "$BACKUP_DB_HOST" "$BACKUP_DB_PORT" "$BACKUP_DB_USER" "$BACKUP_DB_PASSWORD" >"$MYSQL_CNF"
  )
}

cleanup_work_dir() {
  if [ -n "${WORK_DIR:-}" ] && [ -d "$WORK_DIR" ]; then
    rm -rf -- "$WORK_DIR"
  fi
}

# Останній локальний щоденний бекап (імена з UTC-часом сортуються лексикографічно).
latest_backup() {
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'nri-*.sql.gz.enc' | sort | tail -n 1
}
