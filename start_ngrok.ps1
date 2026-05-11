$ErrorActionPreference = "SilentlyContinue"

function Read-DotEnvValue {
    param(
        [string]$Name,
        [string]$DefaultValue = ""
    )

    if (-not (Test-Path ".env")) {
        return $DefaultValue
    }

    $value = $DefaultValue
    foreach ($line in Get-Content ".env") {
        if ($line -match "^\s*$([regex]::Escape($Name))\s*=\s*(.+?)\s*$") {
            $value = $Matches[1].Trim().Trim('"').Trim("'")
        }
    }
    return $value
}

$ngrok = Get-Command "ngrok" -ErrorAction SilentlyContinue
if (-not $ngrok) {
    Write-Host "ngrok is not on PATH. Starting without ngrok."
    Write-Host "Google Drive OAuth from other devices may not work."
    exit 0
}

$port = Read-DotEnvValue -Name "GOOGLE_OAUTH_PORT" -DefaultValue "8080"
$publicBaseUrl = Read-DotEnvValue -Name "GOOGLE_PUBLIC_BASE_URL" -DefaultValue ""

Write-Host "Starting ngrok for Google OAuth callback on port $port..."

if ($publicBaseUrl) {
    $hostName = ($publicBaseUrl -replace "^https?://", "").TrimEnd("/")
    Start-Process -FilePath $ngrok.Source -ArgumentList @("http", "--url=$hostName", $port) -WindowStyle Minimized
} else {
    Start-Process -FilePath $ngrok.Source -ArgumentList @("http", $port) -WindowStyle Minimized
}

for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    try {
        $tunnels = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 1
        $url = ($tunnels.tunnels | Where-Object { $_.proto -eq "https" } | Select-Object -First 1).public_url
        if ($url) {
            $env:GOOGLE_PUBLIC_BASE_URL = $url
            Write-Host "ngrok public URL: $url"
            exit 0
        }
    } catch {
    }
}

if ($publicBaseUrl) {
    $env:GOOGLE_PUBLIC_BASE_URL = $publicBaseUrl
    Write-Host "ngrok public URL: $publicBaseUrl"
} else {
    Write-Host "ngrok started, but public URL was not detected from http://127.0.0.1:4040/api/tunnels."
}
