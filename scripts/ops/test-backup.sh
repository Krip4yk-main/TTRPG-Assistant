#!/bin/bash
# Швидкі перевірки образу/скриптів backup без БД і сховища (не запускає справжній бекап).
# Запуск: bash scripts/ops/test-backup.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
fail=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

# 1. Dockerfile: числовий UID (runAsNonRoot у Kubernetes), група 0 і групові права на /backups.
check "Dockerfile: USER is numeric" grep -Eq '^USER [0-9]+$' "$HERE/Dockerfile.backup"
check "Dockerfile: /backups group-writable, group 0" grep -Eq 'chown -R [0-9]+:0 /backups' "$HERE/Dockerfile.backup"
check "Dockerfile: HOME and TMPDIR point to /tmp" grep -Eq '^ENV .*HOME=/tmp' "$HERE/Dockerfile.backup"

# 2. require_writable_dir: записуваний каталог — ок (створює monthly/), недоступний — зрозуміла помилка.
(
  . "$HERE/backup-lib.sh"
  BACKUP_DIR="$T/vol"
  mkdir -p "$BACKUP_DIR"
  require_writable_dir && [ -d "$BACKUP_DIR/monthly" ]
) && ok "require_writable_dir: writable volume" || bad "require_writable_dir: writable volume"

touch "$T/afile"
out="$( ( . "$HERE/backup-lib.sh"; BACKUP_DIR="$T/afile/vol"; require_writable_dir ) 2>&1 )" && rc=0 || rc=$?
if [ "$rc" -ne 0 ] && echo "$out" | grep -q "not writable"; then ok "require_writable_dir: unusable path fails with message"; else bad "require_writable_dir: unusable path fails with message"; fi

# 3. Без парольної фрази планувальник і бекап не стартують (fail closed), БД не потрібна.
out="$(env -u BACKUP_PASSPHRASE BACKUP_DIR="$T/vol" bash "$HERE/backup-entrypoint.sh" backup 2>&1)" && rc=0 || rc=$?
if [ "$rc" -ne 0 ] && echo "$out" | grep -q BACKUP_PASSPHRASE; then ok "backup refuses without BACKUP_PASSPHRASE"; else bad "backup refuses without BACKUP_PASSPHRASE"; fi

# 4. BACKUP_ENABLED=false: планувальник простоює і зупиняється по SIGTERM з кодом 0.
BACKUP_ENABLED=false BACKUP_DIR="$T/none" bash "$HERE/backup-entrypoint.sh" schedule >"$T/idle.log" 2>&1 &
pid=$!
sleep 1
kill -TERM "$pid" 2>/dev/null
wait "$pid" 2>/dev/null && ok "disabled scheduler idles and stops on SIGTERM" || bad "disabled scheduler idles and stops on SIGTERM"

exit "$fail"
