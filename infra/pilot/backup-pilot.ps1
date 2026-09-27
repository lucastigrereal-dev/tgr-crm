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

function New-HexSecret([int]$Bytes = 32) {
  $buffer = New-Object byte[] $Bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return (($buffer | ForEach-Object { $_.ToString('x2') }) -join '')
}

$appPassword = Read-EnvValue 'MYSQL_APP_PASSWORD'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$restoreDb = 'tgr_crm_restore_' + (Get-Date -Format 'yyyyMMddHHmmss')
$restoreContainer = 'tgr-crm-restore-verify-' + $stamp
$verifyRootPassword = New-HexSecret 32
$verifyAppPassword = New-HexSecret 32
New-Item -ItemType Directory -Force -Path $BackupDirectory | Out-Null
$sqlFile = Join-Path $BackupDirectory ('tgr-crm-pilot-' + $stamp + '.sql')
$documentsFile = Join-Path $BackupDirectory ('tgr-crm-documents-' + $stamp + '.tgz')
$manifestFile = Join-Path $BackupDirectory ('manifest-' + $stamp + '.json')
$containerSql = '/tmp/tgr-crm-' + $stamp + '.sql'
$restoreSql = '/tmp/tgr-crm-restore-' + $stamp + '.sql'

& docker inspect $MySqlContainer *> $null
if ($LASTEXITCODE -ne 0) { throw 'CRM pilot MySQL container is not running.' }
$mysqlImage = (& docker inspect --format '{{.Config.Image}}' $MySqlContainer).Trim()
if (-not $mysqlImage) { throw 'Could not discover CRM pilot MySQL image.' }

& docker exec -e ('MYSQL_PWD=' + $appPassword) $MySqlContainer sh -c ('mysqldump -utgr_app --single-transaction --skip-comments --no-tablespaces --set-gtid-purged=OFF tgr_crm_pilot > ' + $containerSql)
if ($LASTEXITCODE -ne 0) { throw 'CRM pilot mysqldump failed.' }
& docker cp ($MySqlContainer + ':' + $containerSql) $sqlFile | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Copying CRM SQL backup failed.' }
& docker exec $MySqlContainer rm -f $containerSql *> $null 2>$null

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

$documentsVerifyContainer = 'tgr-crm-documents-verify-' + $stamp
try {
  & docker create --name $documentsVerifyContainer busybox:1.36 sh -c 'tar tzf /tmp/documents.tgz >/dev/null' *> $null
  & docker cp $documentsFile ($documentsVerifyContainer + ':/tmp/documents.tgz') | Out-Null
  & docker start -a $documentsVerifyContainer *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Documents archive verification failed.' }
} finally {
  & docker rm -f $documentsVerifyContainer *> $null 2>$null
}

$restoreStarted = $false
try {
  & docker run -d --name $restoreContainer -e ('MYSQL_ROOT_PASSWORD=' + $verifyRootPassword) -e ('MYSQL_DATABASE=' + $restoreDb) -e 'MYSQL_USER=tgr_verify' -e ('MYSQL_PASSWORD=' + $verifyAppPassword) $mysqlImage --skip-log-bin *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Disposable CRM restore verifier could not start.' }
  $restoreStarted = $true
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    & docker exec -e ('MYSQL_PWD=' + $verifyAppPassword) $restoreContainer mysql -utgr_verify -D $restoreDb -Nse 'SELECT 1' *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $ready) { throw 'Disposable CRM restore verifier did not become ready.' }

  & docker cp $sqlFile ($restoreContainer + ':' + $restoreSql) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Copying CRM SQL into verifier failed.' }
  & docker exec -e ('MYSQL_PWD=' + $verifyAppPassword) $restoreContainer sh -c ('mysql -utgr_verify ' + $restoreDb + ' < ' + $restoreSql)
  if ($LASTEXITCODE -ne 0) { throw 'CRM SQL restore drill failed.' }

  $tables = @(& docker exec -e ('MYSQL_PWD=' + $appPassword) $MySqlContainer mysql -utgr_app -Nse "SHOW TABLES FROM tgr_crm_pilot")
  if ($LASTEXITCODE -ne 0 -or $tables.Count -eq 0) { throw 'Could not enumerate CRM pilot tables.' }
  $counts = @()
  foreach ($table in $tables) {
    if ($table -notmatch '^[A-Za-z0-9_]+$') { throw 'Unexpected table identifier.' }
    $source = @(& docker exec -e ('MYSQL_PWD=' + $appPassword) $MySqlContainer mysql -utgr_app -Nse ('SELECT COUNT(*) FROM tgr_crm_pilot.' + $table))[0]
    $restored = @(& docker exec -e ('MYSQL_PWD=' + $verifyAppPassword) $restoreContainer mysql -utgr_verify -Nse ('SELECT COUNT(*) FROM ' + $restoreDb + '.' + $table))[0]
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
    verifierImage = $mysqlImage
    counts = $counts
  }
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestFile -Encoding utf8NoBOM
  Write-Output ('BACKUP_MANIFEST=' + $manifestFile)
  Write-Output ('VERIFIED_TABLES=' + $counts.Count)
  Write-Output 'BACKUP_RESTORE=PASS'
} finally {
  if ($restoreStarted) { & docker rm -f $restoreContainer *> $null 2>$null }
}
