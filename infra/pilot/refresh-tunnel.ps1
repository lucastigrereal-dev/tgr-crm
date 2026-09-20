param([int]$MaxTunnelAttempts = 5)

$ErrorActionPreference = "Stop"
$Compose = Join-Path $PSScriptRoot "docker-compose.yml"
$EnvFile = Join-Path $PSScriptRoot ".env.pilot.local"
$UrlFile = Join-Path $PSScriptRoot ".pilot-url.local.txt"

function Invoke-Compose([string[]]$ComposeArgs) {
  & docker compose --env-file $EnvFile -f $Compose @ComposeArgs
  if ($LASTEXITCODE -ne 0) {
    throw ("docker compose failed: " + ($ComposeArgs -join " "))
  }
}

function Resolve-PublicIpv4([string]$HostName, [string]$Server) {
  try {
    return Resolve-DnsName $HostName -Server $Server -Type A -ErrorAction Stop |
      Where-Object { $_.IPAddress } |
      Select-Object -ExpandProperty IPAddress -First 1
  } catch {
    return $null
  }
}

for ($tunnelAttempt = 1; $tunnelAttempt -le $MaxTunnelAttempts; $tunnelAttempt++) {
  & docker compose --env-file $EnvFile -f $Compose --profile tunnel rm -sf cloudflared *> $null 2>$null
  Invoke-Compose @("--profile", "tunnel", "up", "-d", "--force-recreate", "cloudflared")

  $tunnelUrl = $null
  for ($attempt = 0; $attempt -lt 45; $attempt++) {
    $logs = (& docker compose --env-file $EnvFile -f $Compose --profile tunnel logs --no-color cloudflared 2>&1) -join [Environment]::NewLine
    $match = [regex]::Match($logs, "https://[a-z0-9-]+\.trycloudflare\.com")
    if ($match.Success) { $tunnelUrl = $match.Value; break }
    Start-Sleep -Seconds 2
  }
  if (-not $tunnelUrl) { continue }

  $hostName = ([Uri]$tunnelUrl).Host
  $publicReady = $false
  for ($attempt = 0; $attempt -lt 45; $attempt++) {
    $cfIp = Resolve-PublicIpv4 $hostName "1.1.1.1"
    $googleIp = Resolve-PublicIpv4 $hostName "8.8.8.8"
    if ($cfIp -and $googleIp) {
      & curl.exe --silent --show-error --fail --max-time 8 --resolve ($hostName + ":443:" + $cfIp) ($tunnelUrl + "/api/health/ready") --output NUL
      if ($LASTEXITCODE -eq 0) {
        $publicReady = $true
        break
      }
    }
    Start-Sleep -Seconds 2
  }

  if ($publicReady) {
    Set-Content -LiteralPath $UrlFile -Value $tunnelUrl -Encoding utf8NoBOM
    Write-Output ("PILOT_URL=" + $tunnelUrl)
    Write-Output ("TUNNEL_ATTEMPT=" + $tunnelAttempt)
    Write-Output "PUBLIC_TUNNEL=PASS"
    exit 0
  }
}

throw "Could not create a publicly resolvable CRM pilot tunnel after $MaxTunnelAttempts attempts."
