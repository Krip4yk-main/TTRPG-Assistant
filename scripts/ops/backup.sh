#!/bin/bash
# Зашифрований бекап БД: mysqldump | gzip | openssl enc → $BACKUP_DIR/nri-YYYY-MM-DDTHHMMZ.sql.gz.enc
# Незашифрований дамп не торкається диска: усе йде одним пайпом.
# Ротація: 7 щоденних у $BACKUP_DIR + 4 щотижневих (неділя) у $BACKUP_DIR/weekly.
# Копія поза сервером — rclone (S3: Cloudflare R2 / Backblaze B2), віддалено зберігається 30 днів.
# Документація: docs/ops/backups.md. `set -x` тут заборонено — він би показав секрети.
set -euo pipefail

# shellcheck source=backup-lib.sh
. "$(dirname "$0")/backup-lib.sh"

KEEP_DAILY=7
KEEP_WEEKLY=4
REMOTE_MAX_AGE=30d

require_passphrase
make_mysql_cnf

PARTIAL=""
cleanup() {
  if [ -n "$PARTIAL" ] && [ -f "$PARTIAL" ]; then
    rm -f -- "$PARTIAL"
  fi
  cleanup_work_dir
}
trap cleanup EXIT

mkdir -p "$BACKUP_DIR/weekly"
umask 077

NAME="nri-$(date -u +%Y-%m-%dT%H%MZ).sql.gz.enc"
TARGET="$BACKUP_DIR/$NAME"
PARTIAL="$BACKUP_DIR/.$NAME.partial"

log "backup started: $NAME"
mysqldump --defaults-extra-file="$MYSQL_CNF" \
  --single-transaction --routines --triggers \
  --no-tablespaces --set-gtid-purged=OFF \
  "$BACKUP_DB_NAME" \
  | gzip -c \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_PASSPHRASE -out "$PARTIAL"

# Швидка перевірка цілісності: файл розшифровується, gzip-потік цілий.
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE -in "$PARTIAL" | gzip -t \
  || die "integrity check of the new backup failed"

mv -- "$PARTIAL" "$TARGET"
PARTIAL=""
log "backup written: $TARGET ($(wc -c <"$TARGET") bytes)"

# Неділя (ISO: 7) — щотижнева копія.
if [ "$(date -u +%u)" = "7" ]; then
  cp -p -- "$TARGET" "$BACKUP_DIR/weekly/$NAME"
  log "weekly copy: weekly/$NAME"
fi

# Локальна ротація: лишаємо найновіші N файлів у кожному каталозі.
rotate() {
  local dir="$1" keep="$2" old
  find "$dir" -maxdepth 1 -type f -name 'nri-*.sql.gz.enc' | sort -r | tail -n +"$((keep + 1))" \
    | while IFS= read -r old; do
      rm -f -- "$old"
      log "rotated: ${old#"$BACKUP_DIR"/}"
    done
}
rotate "$BACKUP_DIR" "$KEEP_DAILY"
rotate "$BACKUP_DIR/weekly" "$KEEP_WEEKLY"

# Копія поза сервером. Налаштування rclone — лише зі змінних оточення (не з аргументів).
S3_VARS="BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY"
set_count=0
missing=""
for v in $S3_VARS; do
  if [ -n "${!v:-}" ]; then
    set_count=$((set_count + 1))
  else
    missing="$missing $v"
  fi
done

if [ "$set_count" -eq 0 ]; then
  log "WARN: off-site copy disabled (BACKUP_S3_* not set) — backup kept locally only"
  exit 0
fi
if [ -n "$missing" ]; then
  die "off-site copy misconfigured, missing:$missing (local backup is kept)"
fi

export RCLONE_CONFIG=/dev/null
export RCLONE_CONFIG_OFFSITE_TYPE=s3
export RCLONE_CONFIG_OFFSITE_PROVIDER=Other
export RCLONE_CONFIG_OFFSITE_ENDPOINT="$BACKUP_S3_ENDPOINT"
export RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
export RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_OFFSITE_REGION="${BACKUP_S3_REGION:-}"
# Ключ R2/B2 з доступом лише до одного бакета не може його створювати/перевіряти.
export RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET=true

REMOTE="offsite:$BACKUP_S3_BUCKET/nri"
rclone copyto --stats 0 "$TARGET" "$REMOTE/$NAME" \
  || die "off-site upload failed (local backup is kept)"
log "off-site copy uploaded: $NAME"

rclone delete --stats 0 --min-age "$REMOTE_MAX_AGE" --include 'nri-*.sql.gz.enc' "$REMOTE" \
  || die "off-site rotation failed"
log "off-site rotation done (older than $REMOTE_MAX_AGE removed)"
log "backup finished"
