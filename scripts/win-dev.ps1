# 開発用の常駐サーバー（node src/server.ts）と web の dev server（vite）を、Windows 側で切り離して起動する。
# WSL interop から呼ぶので、起動したプロセスの PID とログは .dev/ に残し、止めるのは win-dev-stop.ps1 に任せる。
#   win-dev.ps1            server と web を起動
#   win-dev.ps1 -Server    server だけ
#   win-dev.ps1 -Web       web だけ
param([switch]$Server, [switch]$Web)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$env:Path = "C:\Program Files\nodejs;$env:APPDATA\npm;$env:Path"
$dev = Join-Path $root ".dev"
New-Item -ItemType Directory -Force -Path $dev | Out-Null
if (-not $Server -and -not $Web) { $Server = $true; $Web = $true }

function Start-Detached([string]$name, [string]$workdir, [string]$command, [string[]]$arguments) {
  $pidFile = Join-Path $dev "$name.pid"
  if (Test-Path $pidFile) {
    $existing = Get-Content $pidFile
    if (Get-Process -Id $existing -ErrorAction SilentlyContinue) { Write-Host "$name はもう動いています（pid $existing）"; return }
    Remove-Item $pidFile
  }
  $out = Join-Path $dev "$name.log"
  $err = Join-Path $dev "$name.err.log"
  $process = Start-Process -FilePath $command -ArgumentList $arguments -WorkingDirectory $workdir -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  Set-Content -Path $pidFile -Value $process.Id
  Write-Host "$name を起動しました（pid $($process.Id)、ログ $out / $err）"
}

if ($Server) { Start-Detached "server" (Join-Path $root "server") "node" @("src/server.ts") }
if ($Web) { Start-Detached "web" (Join-Path $root "web") "cmd" @("/c", "pnpm", "dev") }
