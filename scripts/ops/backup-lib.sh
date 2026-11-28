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

# Fail closed і зрозуміло: каталог локальних копій (том) має існувати й бути записуваним поточним
# UID (у Kubernetes — довільним; том потребує fsGroup або відповідних прав). Створює monthly/.
require_writable_dir() {
  local d="${1:-$BACKUP_DIR}"
  if ! mkdir -p -- "$d/monthly" 2>/dev/null || [ ! -w "$d" ] || [ ! -w "$d/monthly" ]; then
    die "$d is not writable by uid $(id -u) — mount a volume there and make it writable (fsGroup / chmod g+w)"
  fi
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

# Ім'я бекапу nri-YYYY-MM-DDTHHMMZ.sql.gz.enc → місяць (YYYY-MM).
backup_month() { local n="${1#nri-}"; printf '%s' "${n:0:7}"; }

# Чи потрібна місячна копія: за місяць цього файлу копії ще немає. Бекап 1-го числа —
# найперший у місяці, тож він і стає копією; повторний запуск того ж дня (чи пізніше в
# місяці) копію не дублює. $1 — ім'я файлу, $2 — чи існує вже копія за його місяць (yes|no).
monthly_copy_needed() {
  [ "$2" = "no" ]
}

# Прибирає недописані бекапи (.nri-*.partial), що лишилися від перерваних запусків
# (OOM, kill -9, вимкнення сервера — trap EXIT тоді не спрацьовує). Чіпаємо лише файли без
# запису понад PARTIAL_STALE_MIN хвилин: паралельний ручний запуск пише свій .partial
# безперервно, тож його не зачепимо.
PARTIAL_STALE_MIN="${PARTIAL_STALE_MIN:-10}"
clean_stale_partials() {
  local old
  find "$BACKUP_DIR" -maxdepth 1 -type f -name '.nri-*.partial' -mmin +"$PARTIAL_STALE_MIN" \
    | while IFS= read -r old; do
      rm -f -- "$old"
      log "removed stale partial: ${old#"$BACKUP_DIR"/}"
    done
}

# Локальна ротація: лишаємо найновіші N файлів у каталозі (імена сортуються за датою).
rotate_dir() {
  local dir="$1" keep="$2" old
  find "$dir" -maxdepth 1 -type f -name 'nri-*.sql.gz.enc' | sort -r | tail -n +"$((keep + 1))" \
    | while IFS= read -r old; do
      rm -f -- "$old"
      log "rotated: ${old#"$BACKUP_DIR"/}"
    done
}

# Локальна місячна копія у $BACKUP_DIR/monthly. $1 — ім'я файлу (він уже в $BACKUP_DIR).
local_monthly_copy() {
  local name="$1" month have=no
  month="$(backup_month "$name")"
  mkdir -p "$BACKUP_DIR/monthly"
  if [ -n "$(find "$BACKUP_DIR/monthly" -maxdepth 1 -type f -name "nri-${month}-*.sql.gz.enc" -print -quit)" ]; then
    have=yes
  fi
  if monthly_copy_needed "$name" "$have"; then
    cp -p -- "$BACKUP_DIR/$name" "$BACKUP_DIR/monthly/$name"
    log "monthly copy: monthly/$name"
  fi
}
