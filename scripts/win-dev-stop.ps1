# win-dev.ps1 が起動した server・web を、記録した PID から子孫ごと止める（進行中のセッションは書き出されない。先に cli stop）
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dev = Join-Path $root ".dev"
foreach ($name in @("server", "web")) {
  $pidFile = Join-Path $dev "$name.pid"
  if (-not (Test-Path $pidFile)) { continue }
  $id = Get-Content $pidFile
  if (Get-Process -Id $id -ErrorAction SilentlyContinue) {
    & taskkill /PID $id /T /F | Out-Null
    Write-Host "$name を止めました（pid $id）"
  } else {
    Write-Host "$name は動いていません（記録の pid $id）"
  }
  Remove-Item $pidFile
}
