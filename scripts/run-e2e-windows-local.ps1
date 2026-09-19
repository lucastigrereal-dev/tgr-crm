param(
  [string]$RunId = ("win_" + (Get-Date -Format "yyyyMMdd_HHmmss")),
  [int]$MySqlPort = 43336,
  [int]$AppPort = 43337,
  [string]$ContainerName = "tgr-crm-e2e-local"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $root

if ($RunId -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$') {
  throw "RunId must satisfy the E2E fixture contract."
}
$normalizedRunId = $RunId.ToLowerInvariant().Replace("-", "_")
$databaseName = "tgr_crm_" + $normalizedRunId + "_e2e"
$databaseUrl = "mysql://root:tgr-e2e-root@127.0.0.1:" + $MySqlPort + "/" + $databaseName
$baseUrl = "http://127.0.0.1:" + $AppPort
$ownerOpenId = "E2E-TGR-" + $RunId + "-OWNER"
$receiptPath = "e2e/.runtime/receipt-" + $RunId + ".json"
$logPath = Join-Path $root ("docs/audit/windows-e2e-" + $RunId + ".log")

$env:E2E_RUN_ID = $RunId
$env:E2E_DATABASE_URL = $databaseUrl
$env:E2E_CONFIRM_ISOLATED = "I_CONFIRM_ISOLATED_E2E"
$env:E2E_STRICT = "1"
$env:E2E_BASE_URL = $baseUrl
$env:E2E_RECEIPT_PATH = $receiptPath
$env:JWT_SECRET = "windows-e2e-only-secret-with-at-least-32-characters"
$env:VITE_APP_ID = "tgr-e2e"
$env:OAUTH_SERVER_URL = "http://127.0.0.1:65535"
$env:OWNER_OPEN_ID = $ownerOpenId

"START=$(Get-Date -Format o)" | Set-Content -LiteralPath $logPath -Encoding utf8
$prepared = $false

$existingAppListener = Get-NetTCPConnection -LocalPort $AppPort -State Listen -ErrorAction SilentlyContinue
if ($existingAppListener) {
  $owners = ($existingAppListener | Select-Object -ExpandProperty OwningProcess -Unique) -join ","
  throw "AppPort $AppPort is already occupied by PID(s) $owners. Refusing to reuse an existing server."
}

try {
  docker rm -f $ContainerName *> $null 2>$null
  docker run -d --name $ContainerName -e MYSQL_ROOT_PASSWORD=tgr-e2e-root -p ("127.0.0.1:" + $MySqlPort + ":3306") mysql:8.4 | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) { throw "MySQL E2E container failed to start." }

  $healthy = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    docker exec $ContainerName mysqladmin ping -h 127.0.0.1 -uroot -ptgr-e2e-root --silent *> $null
    if ($LASTEXITCODE -eq 0) { $healthy = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $healthy) { throw "MySQL E2E did not become ready." }

  $env:DATABASE_URL = $env:E2E_DATABASE_URL
  & corepack pnpm config:doctor:e2e 2>&1 | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) { throw "E2E config doctor failed." }

  $env:DATABASE_URL = ""
  & node scripts/check-e2e-isolation.mjs 2>&1 | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) { throw "E2E isolation check failed." }

  & node scripts/prepare-e2e-database.mjs 2>&1 | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) { throw "E2E database preparation failed." }
  $prepared = $true

  $env:DATABASE_URL = $env:E2E_DATABASE_URL
  & corepack pnpm exec drizzle-kit migrate 2>&1 | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) { throw "E2E migrations failed." }

  $env:DATABASE_URL = ""
  & node scripts/seed-e2e-isolated.mjs 2>&1 | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) { throw "E2E seed failed." }

  $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
  $env:E2E_CANCELLATION_CONTRACT_ID = [string]$receipt.contractId
  $env:DATABASE_URL = $env:E2E_DATABASE_URL

  & corepack pnpm exec playwright test e2e/strict-isolated.spec.ts --reporter=line 2>&1 | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) { throw "Playwright strict journeys failed." }

  "RESULT=PASS" | Tee-Object -FilePath $logPath -Append
  Write-Output "WINDOWS_E2E=PASS"
  Write-Output ("LOG=" + $logPath)
} finally {
  if ($prepared) {
    $env:DATABASE_URL = ""
    & node scripts/cleanup-e2e-isolated.mjs 2>&1 | Tee-Object -FilePath $logPath -Append
    $cleanupExit = $LASTEXITCODE
    "CLEANUP_EXIT=$cleanupExit" | Tee-Object -FilePath $logPath -Append
    if ($cleanupExit -ne 0) { Write-Error "Run-owned E2E database cleanup failed." }
  }
  docker rm -f $ContainerName *> $null 2>$null
}