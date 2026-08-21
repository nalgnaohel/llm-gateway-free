# Bootstrap for Windows employee machines: ensure Node 22+, then hand off to
# install-agent.mjs for everything else.
#
#   $env:AIGW_REPO_URL = "<internal git remote>"
#   .\scripts\install-agent.ps1
#   .\scripts\install-agent.ps1 --check
#
# NOTE: the winget package id/version pin below has not been verified against
# a live Windows machine - confirm it (or the nvm-windows fallback) before
# relying on this for a real company rollout. See docs/CLIENT_ROLLOUT.md.
$ErrorActionPreference = "Stop"

function Test-Node22 {
  try {
    $v = (& node --version) 2>$null
  } catch {
    return $false
  }
  if (-not $v) { return $false }
  $major = [int]($v.TrimStart('v').Split('.')[0])
  return $major -ge 22
}

if (-not (Test-Node22)) {
  Write-Host "node missing or <22 - installing"

  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id OpenJS.NodeJS --version 22 -e --accept-package-agreements --accept-source-agreements
  } else {
    Write-Host "winget not found - installing via nvm-windows"
    $nvmInstaller = Join-Path $env:TEMP "nvm-setup.exe"
    Invoke-WebRequest -Uri "https://github.com/coreybutler/nvm-windows/releases/latest/download/nvm-setup.exe" -OutFile $nvmInstaller
    Start-Process -FilePath $nvmInstaller -ArgumentList "/SILENT" -Wait
    & nvm install 22
    & nvm use 22
  }

  if (-not (Test-Node22)) {
    Write-Error "node still missing or <22 after install - install Node 22+ manually and re-run"
    exit 1
  }
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node "$ScriptDir\install-agent.mjs" @args
