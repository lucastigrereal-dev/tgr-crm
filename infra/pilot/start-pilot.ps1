$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Compose = Join-Path $PSScriptRoot 'docker-compose.yml'
$EnvFile = Join-Path $PSScriptRoot '.env.pilot.local'
$CredentialsFile = Join-Path $PSScriptRoot '.pilot-credentials.local.txt'
$UrlFile = Join-Path $PSScriptRoot '.pilot-url.local.txt'

function New-HexSecret([int]$Bytes = 32) {
  return [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes($Bytes)).ToLowerInvariant()
}

function Read-EnvFile {
  $map = [ordered]@{}
  if (Test-Path $EnvFile) {
    foreach ($line in Get-Content -LiteralPath $EnvFile) {
      if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#')) { continue }
      $parts = $line -split '=', 2
      if ($parts.Count -eq 2) { $map[$parts[0]] = $parts[1] }
    }
  }
  return $map
}

function Write-EnvFile($map) {
  $content = foreach ($key in $map.Keys) { $key + '=' + $map[$key] }
  Set-Content -LiteralPath $EnvFile -Value $content -Encoding utf8NoBOM
}

function Invoke-Compose([string[]]$ComposeArgs) {
  & docker compose --env-file $EnvFile -f $Compose @ComposeArgs
  if ($LASTEXITCODE -ne 0) { throw ('docker compose failed: ' + ($ComposeArgs -join ' ')) }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker is required.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node is required to initialize the credential hash.' }
& docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker engine is not running.' }

$envMap = Read-EnvFile
$firstProvision = -not (Test-Path $CredentialsFile)
if (-not $envMap.Contains('MYSQL_ROOT_PASSWORD')) { $envMap['MYSQL_ROOT_PASSWORD'] = New-HexSecret 32 }
if (-not $envMap.Contains('MYSQL_APP_PASSWORD')) { $envMap['MYSQL_APP_PASSWORD'] = New-HexSecret 32 }
if (-not $envMap.Contains('JWT_SECRET')) { $envMap['JWT_SECRET'] = New-HexSecret 48 }
if (-not $envMap.Contains('LOCAL_AUTH_USERNAME')) { $envMap['LOCAL_AUTH_USERNAME'] = 'lucas.admin' }
if (-not $envMap.Contains('LOCAL_AUTH_DISPLAY_NAME')) { $envMap['LOCAL_AUTH_DISPLAY_NAME'] = 'Lucas Tigre - Admin CRM' }

if ($firstProvision) {
  $plainPassword = New-HexSecret 18
  $hashScript = Join-Path $Root 'scripts\hash-local-password.mjs'
  $passwordHash = ($plainPassword | & node $hashScript).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $passwordHash.StartsWith('scrypt:')) { throw 'Could not generate local password hash.' }
  $envMap['LOCAL_AUTH_PASSWORD_HASH'] = $passwordHash
  @(
    'TGR CRM - credencial inicial de piloto',
    ('username=' + $envMap['LOCAL_AUTH_USERNAME']),
    ('password=' + $plainPassword),
    ('created_at=' + [DateTimeOffset]::Now.ToString('o'))
  ) | Set-Content -LiteralPath $CredentialsFile -Encoding utf8NoBOM
  try { & icacls $CredentialsFile /inheritance:r /grant:r ($env:USERNAME + ':(R,W)') *> $null } catch {}
} elseif (-not $envMap.Contains('LOCAL_AUTH_PASSWORD_HASH')) {
  throw 'LOCAL_AUTH_PASSWORD_HASH is missing but credentials already exist. Refusing to rotate silently.'
} elseif (-not $envMap['LOCAL_AUTH_PASSWORD_HASH'].StartsWith('scrypt:')) {
  $credentialLines = Get-Content -LiteralPath $CredentialsFile
  $passwordLine = $credentialLines | Where-Object { $_.StartsWith('password=') } | Select-Object -First 1
  if (-not $passwordLine) { throw 'Existing pilot credential cannot be migrated without its local password file.' }
  $existingPassword = $passwordLine.Substring('password='.Length)
  $hashScript = Join-Path $Root 'scripts\hash-local-password.mjs'
  $migratedHash = ($existingPassword | & node $hashScript).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $migratedHash.StartsWith('scrypt:')) { throw 'Could not migrate local password hash.' }
  $envMap['LOCAL_AUTH_PASSWORD_HASH'] = $migratedHash
}

Write-EnvFile $envMap
try { & icacls $EnvFile /inheritance:r /grant:r ($env:USERNAME + ':(R,W)') *> $null } catch {}

Set-Location -LiteralPath $Root
Invoke-Compose @('build', 'app')
Invoke-Compose @('up', '-d', '--wait', 'mysql')
Invoke-Compose @('--profile', 'admin', 'run', '--rm', 'migrate')
Invoke-Compose @('run', '--rm', 'app', 'node', 'scripts/config-doctor.mjs', '--strict')
Invoke-Compose @('up', '-d', '--force-recreate', 'app')

$localReady = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:44100/api/health/ready' -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -eq 200) { $localReady = $true; break }
  } catch {}
  Start-Sleep -Seconds 2
}
if (-not $localReady) { throw 'CRM pilot did not become locally ready.' }

$refreshTunnel = Join-Path $PSScriptRoot 'refresh-tunnel.ps1'
& $refreshTunnel
if ($LASTEXITCODE -ne 0) { throw 'CRM public tunnel refresh failed.' }
$tunnelUrl = (Get-Content -LiteralPath $UrlFile -Raw).Trim()
Write-Output ('PILOT_URL=' + $tunnelUrl)
Write-Output ('CREDENTIALS_FILE=' + $CredentialsFile)
Write-Output 'READY=PASS'
