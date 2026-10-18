# 会議の開始を 1 コマンドで行う。サーバーと画面が起きていなければ起こし（win-dev.ps1）、会議アプリを選び、セッションを開始し、
# 閲覧の共有（Android 用の URL）を開き、ブラウザで画面を開く。
#   win-meeting-start.ps1                       音を出している会議アプリを自動で選ぶ（1 つだけ音を出しているとき）
#   win-meeting-start.ps1 Zoom.exe              会議アプリを指定する（cli apps の id = 実行ファイル名）
#   win-meeting-start.ps1 Zoom.exe "週次定例"   会議の名前も付ける（省略すると開始時刻）
#   -NoShare: 閲覧の共有を開かない。-NoBrowser: ブラウザを開かない
# 終わるときは win-meeting-stop.ps1
param([string]$App, [string]$Title, [switch]$NoShare, [switch]$NoBrowser)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$env:Path = "C:\Program Files\nodejs;$env:APPDATA\npm;$env:Path"
$port = if ($env:LIVE_MINDMAP_PORT) { $env:LIVE_MINDMAP_PORT } else { "4319" }
$webPort = "5173"

function Listening([string]$p) { [bool](netstat -ano | Select-String "LISTENING" | Select-String ":$p ") }
function Invoke-Cli {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$a)
  $out = & node (Join-Path $root "server\src\cli.ts") @a
  if ($LASTEXITCODE -ne 0) { throw "cli $($a -join ' ') が失敗しました（exit $LASTEXITCODE）" }
  return ($out -join "`n")
}

# サーバーと画面。win-dev.ps1 は動いているものを飛ばす
if (-not (Listening $port) -or -not (Listening $webPort)) {
  Write-Host "サーバーと画面を起こしています..."
  & (Join-Path $PSScriptRoot "win-dev.ps1")
  $deadline = (Get-Date).AddSeconds(40)
  while ((-not (Listening $port) -or -not (Listening $webPort)) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (-not (Listening $port)) { throw "サーバーがポート $port で待ち受けません（.dev\server.err.log を見る）" }
}

# 会議アプリ。指定が無ければ、音を出しているアプリが 1 つだけのときにそれを選ぶ
if (-not $App) {
  # PowerShell 5.1 の ConvertFrom-Json は配列を 1 つの塊で返すので、ForEach-Object で 1 件ずつにほどく
  $apps = @(((Invoke-Cli apps) | ConvertFrom-Json) | ForEach-Object { $_ })
  $active = @($apps | Where-Object { $_.active })
  if ($active.Count -eq 1) {
    $App = $active[0].id
    Write-Host "音を出している会議アプリ: $App"
  } elseif ($active.Count -gt 1) {
    Write-Host "音を出しているアプリが複数あります。引数で選んでください: $(($active | ForEach-Object { $_.id }) -join ', ')"
    exit 2
  } else {
    Write-Host "音を出している会議アプリがありません。会議に入ってからやり直すか、引数で指定してください（候補: $(($apps | ForEach-Object { $_.id }) -join ', ')）"
    exit 2
  }
}

$startArgs = @("start", "--app", $App)
if ($Title) { $startArgs += @("--title", $Title) }
$dir = Invoke-Cli @startArgs
Write-Host "セッションを開始しました（会議アプリ $App）: $dir"
if (-not $NoShare) { Write-Host (Invoke-Cli share) }
if (-not $NoBrowser) { Start-Process "http://localhost:$webPort/" }
Write-Host "終わるときは scripts\win-meeting-stop.cmd"
