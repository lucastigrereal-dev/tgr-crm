$ErrorActionPreference = 'Stop'
$Compose = Join-Path $PSScriptRoot 'docker-compose.yml'
$EnvFile = Join-Path $PSScriptRoot '.env.pilot.local'
$UrlFile = Join-Path $PSScriptRoot '.pilot-url.local.txt'
& docker compose --env-file $EnvFile -f $Compose --profile tunnel ps
if (Test-Path $UrlFile) { Write-Output ('PILOT_URL=' + (Get-Content -LiteralPath $UrlFile -Raw).Trim()) }