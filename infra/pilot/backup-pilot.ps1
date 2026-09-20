param(
  [string]$BackupDirectory = (Join-Path $env:USERPROFILE 'Documents\TGR-CRM-Pilot-Backups')
)

$ErrorActionPreference = 'Stop'
$EnvFile = Join-Path $PSScriptRoot '.env.pilot.local'
$MySqlContainer = 'tgr-crm-pilot-mysql-1'
$DocumentsVolume = 'tgr-crm-pilot_documents_data'

function Read-EnvValue([string]$Name) {
  foreach ($line in Get-Content -LiteralPath $EnvFile) {
    if ($line.StartsWith($Name + '=')) { return $line.Substring($Name.Length + 1) }
  }
  throw ($Name + ' not found in pilot env')
}

$rootPassword = Read-EnvValue 'MYSQL_ROOT_PASSWORD'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$restoreDb = 'tgr_crm_restore_' + (Get-Date -Format 'yyyyMMddHHmmss')
New-Item -ItemType Directory -Force -Path $BackupDirectory | Out-Null
$sqlFile = Join-Path $BackupDirectory ('tgr-crm-pilot-' + $stamp + '.sql')
$documentsFile = Join-Path $BackupDirectory ('tgr-crm-documents-' + $stamp + '.tgz')
$manifestFile = Join-Path $BackupDirectory ('manifest-' + $stamp + '.json')
$containerSql = '/tmp/tgr-crm-' + $stamp + '.sql'
$containerRestore = '/tmp/tgr-crm-restore-' + $stamp + '.sql'

& docker inspect $MySqlContainer *> $null
if ($LASTEXITCODE -ne 0) { throw 'CRM pilot MySQL container is not running.' }

& docker exec -e ('MYSQL_PWD=' + $rootPassword) $MySqlContainer sh -c ('mysqldump -uroot --single-transaction --skip-comments --no-tablespaces --set-gtid-purged=OFF tgr_crm_pilot > ' + $containerSql)
if ($LASTEXITCODE -ne 0) { throw 'CRM pilot mysqldump failed.' }
& docker cp ($MySqlContainer + ':' + $containerSql) $sqlFile | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Copying CRM SQL backup failed.' }

$documentsContainer = 'tgr-crm-documents-backup-' + $stamp
try {
  & docker create --name $documentsContainer -v ($DocumentsVolume + ':/data:ro') busybox:1.36 sh -c 'tar czf /tmp/documents.tgz -C /data .' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Documents backup container creation failed.' }
  & docker start -a $documentsContainer *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Documents archive creation failed.' }
  & docker cp ($documentsContainer + ':/tmp/documents.tgz') $documentsFile | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Copying documents archive failed.' }
} finally {
  & docker rm -f $documentsContainer *> $null 2>$null
}

$verifyContainer = 'tgr-crm-documents-verify-' + $stamp
try {
  & docker create --name $verifyContainer busybox:1.36 sh -c 'tar tzf /tmp/documents.tgz >/dev/null' *> $null
  & docker cp $documentsFile ($verifyContainer + ':/tmp/documents.tgz') | Out-Null
  & docker start -a $verifyContainer *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Documents archive verification failed.' }
} finally {
  & docker rm -f $verifyContainer *> $null 2>$null
}

$restoreCreated = $false
try {
  & docker exec -e ('MYSQL_PWD=' + $rootPassword) $MySqlContainer mysql -uroot -Nse ('CREATE DATABASE ' + $restoreDb + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci')
  if ($LASTEXITCODE -ne 0) { throw 'Temporary restore database creation failed.' }
  $restoreCreated = $true
  & docker cp $sqlFile ($MySqlContainer + ':' + $containerRestore) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Copying SQL for restore failed.' }
  & docker exec -e ('MYSQL_PWD=' + $rootPassword) $MySqlContainer sh -c ('mysql -uroot ' + $restoreDb + ' < ' + $containerRestore)
  if ($LASTEXITCODE -ne 0) { throw 'CRM SQL restore failed.' }

  $tables = @(& docker exec -e ('MYSQL_PWD=' + $rootPassword) $MySqlContainer mysql -uroot -Nse "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='tgr_crm_pilot' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME")
  if ($LASTEXITCODE -ne 0 -or $tables.Count -eq 0) { throw 'Could not enumerate CRM pilot tables.' }
  $counts = @()
  foreach ($table in $tables) {
    if ($table -notmatch '^[A-Za-z0-9_]+$') { throw 'Unexpected table identifier.' }
    $source = @(& docker exec -e ('MYSQL_PWD=' + $rootPassword) $MySqlContainer mysql -uroot -Nse ('SELECT COUNT(*) FROM tgr_crm_pilot.' + $table))[0]
    $restored = @(& docker exec -e ('MYSQL_PWD=' + $rootPassword) $MySqlContainer mysql -uroot -Nse ('SELECT COUNT(*) FROM ' + $restoreDb + '.' + $table))[0]
    if ([int64]$source -ne [int64]$restored) { throw ('Restore mismatch in table ' + $table) }
    $counts += [pscustomobject]@{ table = $table; source = [int64]$source; restored = [int64]$restored }
  }

  $manifest = [pscustomobject]@{
    createdAt = [DateTimeOffset]::Now.ToString('o')
    sqlFile = $sqlFile
    sqlSha256 = (Get-FileHash -Algorithm SHA256 $sqlFile).Hash
    documentsFile = $documentsFile
    documentsSha256 = (Get-FileHash -Algorithm SHA256 $documentsFile).Hash
    verifiedTables = $counts.Count
    counts = $counts
  }
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestFile -Encoding utf8NoBOM
  Write-Output ('BACKUP_MANIFEST=' + $manifestFile)
  Write-Output ('VERIFIED_TABLES=' + $counts.Count)
  Write-Output 'BACKUP_RESTORE=PASS'
} finally {
  if ($restoreCreated) {
    & docker exec -e ('MYSQL_PWD=' + $rootPassword) $MySqlContainer mysql -uroot -Nse ('DROP DATABASE IF EXISTS ' + $restoreDb) *> $null
  }
  & docker exec $MySqlContainer rm -f $containerSql $containerRestore *> $null 2>$null
}
