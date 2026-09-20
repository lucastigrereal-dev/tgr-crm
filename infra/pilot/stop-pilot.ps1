$ErrorActionPreference = 'Stop'
$Compose = Join-Path $PSScriptRoot 'docker-compose.yml'
$EnvFile = Join-Path $PSScriptRoot '.env.pilot.local'
& docker compose --env-file $EnvFile -f $Compose --profile tunnel down
if ($LASTEXITCODE -ne 0) { throw 'Failed to stop CRM pilot stack.' }
Write-Output 'CRM pilot stopped. Persistent volumes were preserved.'