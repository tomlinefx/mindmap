# 会議の終了を 1 コマンドで行う。セッションを終了して map.md・map.json・map.drawnix・map.html を書き出し、その場所を出す。
# 閲覧の共有はセッションの終了で閉じる。サーバーと画面は次の会議のために残す（-StopServer で server stop と画面の停止まで行う）
param([switch]$StopServer)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$env:Path = "C:\Program Files\nodejs;$env:APPDATA\npm;$env:Path"

function Invoke-Cli {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$a)
  $out = & node (Join-Path $root "server\src\cli.ts") @a
  if ($LASTEXITCODE -ne 0) { throw "cli $($a -join ' ') が失敗しました（exit $LASTEXITCODE）" }
  return $out
}

$paths = @(Invoke-Cli stop)
Write-Host "セッションを終了し、書き出しました:"
foreach ($path in $paths) { Write-Host "  $path" }

if ($StopServer) {
  Write-Host (Invoke-Cli server stop)
  & (Join-Path $PSScriptRoot "win-dev-stop.ps1")
}
