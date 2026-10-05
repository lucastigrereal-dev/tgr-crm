#!/usr/bin/env bash
# Backup + restore drill para Linux, equivalente ao backup-pilot.ps1.
# Só lê o banco de origem; o restore acontece num container MySQL descartável.
#
# Variáveis:
#   MYSQL_CONTAINER   container MySQL de origem (padrão tgr-crm-pilot-mysql-1)
#   DB_NAME           banco de origem (padrão tgr_crm_pilot)
#   APP_USER          usuário de aplicação, sem root (padrão tgr_app)
#   APP_PASSWORD      senha do usuário de aplicação (obrigatória, nunca impressa)
#   DOCUMENTS_VOLUME  volume de documentos privados (opcional; vazio = pula)
#   BACKUP_DIR        destino (padrão ./tgr-crm-backups)
set -euo pipefail

MYSQL_CONTAINER="${MYSQL_CONTAINER:-tgr-crm-pilot-mysql-1}"
DB_NAME="${DB_NAME:-tgr_crm_pilot}"
APP_USER="${APP_USER:-tgr_app}"
DOCUMENTS_VOLUME="${DOCUMENTS_VOLUME:-}"
BACKUP_DIR="${BACKUP_DIR:-./tgr-crm-backups}"
: "${APP_PASSWORD:?APP_PASSWORD is required}"

[[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || { echo "Unexpected database identifier." >&2; exit 1; }
stamp="$(date +%Y%m%d-%H%M%S)"
restore_db="tgr_crm_restore_$(date +%Y%m%d%H%M%S)"
restore_container="tgr-crm-restore-verify-${stamp}"
verify_root_password="$(openssl rand -hex 32)"
verify_app_password="$(openssl rand -hex 32)"
mkdir -p "$BACKUP_DIR"
sql_file="$BACKUP_DIR/tgr-crm-${stamp}.sql"
documents_file="$BACKUP_DIR/tgr-crm-documents-${stamp}.tgz"
manifest_file="$BACKUP_DIR/manifest-${stamp}.json"

cleanup() {
  docker rm -f "$restore_container" "tgr-crm-documents-backup-${stamp}" "tgr-crm-documents-verify-${stamp}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker inspect "$MYSQL_CONTAINER" >/dev/null 2>&1 || { echo "CRM MySQL container is not running." >&2; exit 1; }
mysql_image="$(docker inspect --format '{{.Config.Image}}' "$MYSQL_CONTAINER")"
src_mysql() { docker exec -e MYSQL_PWD="$APP_PASSWORD" "$MYSQL_CONTAINER" mysql -u"$APP_USER" -Nse "$1"; }
dst_mysql() { docker exec -e MYSQL_PWD="$verify_app_password" "$restore_container" mysql -utgr_verify -Nse "$1"; }

docker exec -e MYSQL_PWD="$APP_PASSWORD" "$MYSQL_CONTAINER" \
  mysqldump -u"$APP_USER" --single-transaction --skip-comments --no-tablespaces --set-gtid-purged=OFF "$DB_NAME" > "$sql_file"
[[ -s "$sql_file" ]] || { echo "CRM mysqldump produced an empty file." >&2; exit 1; }

documents_sha=""
if [[ -n "$DOCUMENTS_VOLUME" ]]; then
  docker run --name "tgr-crm-documents-backup-${stamp}" -v "${DOCUMENTS_VOLUME}:/data:ro" busybox:1.36 \
    sh -c 'tar czf /tmp/documents.tgz -C /data .' >/dev/null
  docker cp "tgr-crm-documents-backup-${stamp}:/tmp/documents.tgz" "$documents_file" >/dev/null
  docker create --name "tgr-crm-documents-verify-${stamp}" busybox:1.36 sh -c 'tar tzf /tmp/documents.tgz >/dev/null' >/dev/null
  docker cp "$documents_file" "tgr-crm-documents-verify-${stamp}:/tmp/documents.tgz" >/dev/null
  docker start -a "tgr-crm-documents-verify-${stamp}" >/dev/null || { echo "Documents archive verification failed." >&2; exit 1; }
  documents_sha="$(sha256sum "$documents_file" | cut -d' ' -f1)"
fi

docker run -d --name "$restore_container" -e MYSQL_ROOT_PASSWORD="$verify_root_password" -e MYSQL_DATABASE="$restore_db" \
  -e MYSQL_USER=tgr_verify -e MYSQL_PASSWORD="$verify_app_password" "$mysql_image" --skip-log-bin >/dev/null
for _ in $(seq 1 60); do
  dst_mysql "SELECT 1" >/dev/null 2>&1 && break
  sleep 2
done
dst_mysql "SELECT 1" >/dev/null 2>&1 || { echo "Disposable CRM restore verifier did not become ready." >&2; exit 1; }
docker exec -i -e MYSQL_PWD="$verify_app_password" "$restore_container" mysql -utgr_verify "$restore_db" < "$sql_file"

mapfile -t tables < <(src_mysql "SHOW TABLES FROM \`$DB_NAME\`")
(( ${#tables[@]} > 0 )) || { echo "Could not enumerate CRM tables." >&2; exit 1; }
counts_json=""
for table in "${tables[@]}"; do
  [[ "$table" =~ ^[A-Za-z0-9_]+$ ]] || { echo "Unexpected table identifier." >&2; exit 1; }
  source_count="$(src_mysql "SELECT COUNT(*) FROM \`$DB_NAME\`.\`$table\`")"
  restored_count="$(dst_mysql "SELECT COUNT(*) FROM \`$restore_db\`.\`$table\`")"
  source_checksum="$(src_mysql "CHECKSUM TABLE \`$DB_NAME\`.\`$table\`" | awk '{print $2}')"
  restored_checksum="$(dst_mysql "CHECKSUM TABLE \`$restore_db\`.\`$table\`" | awk '{print $2}')"
  [[ "$source_count" == "$restored_count" ]] || { echo "Restore count mismatch in table $table" >&2; exit 1; }
  [[ "$source_checksum" == "$restored_checksum" ]] || { echo "Restore checksum mismatch in table $table" >&2; exit 1; }
  counts_json+="${counts_json:+,}{\"table\":\"$table\",\"rows\":$source_count,\"checksum\":\"$source_checksum\"}"
done

cat > "$manifest_file" <<JSON
{"createdAt":"$(date -Iseconds)","database":"$DB_NAME","sqlFile":"$sql_file","sqlSha256":"$(sha256sum "$sql_file" | cut -d' ' -f1)","documentsFile":"${DOCUMENTS_VOLUME:+$documents_file}","documentsSha256":"$documents_sha","verifiedTables":${#tables[@]},"verifierImage":"$mysql_image","tables":[${counts_json}]}
JSON
echo "BACKUP_MANIFEST=$manifest_file"
echo "VERIFIED_TABLES=${#tables[@]}"
echo "BACKUP_RESTORE=PASS"
