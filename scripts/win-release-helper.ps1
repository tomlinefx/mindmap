# ビルド済みの helper の配布物（zip）を作る（ADR 0006）。利用者は .NET SDK や Visual Studio を入れずに、
# この zip を %LOCALAPPDATA%\mindmap\helper に展開すれば helper を使える（server/src/helperPath.ts がそこを見る）。
#   1. scripts/win-webrtc-apm.ps1 で webrtc-apm.dll（エコーキャンセル）を用意する（無ければ作る。Visual Studio の C++ が要る）
#   2. dotnet publish を self-contained（.NET ランタイム同梱）で helper/.release/mindmap-helper-win-x64/ に出す
#   3. 配布に要るもの（実行ファイル・dll・LICENSE・THIRD_PARTY_NOTICES.md・LICENSES/）がそろっているか確かめて zip にする
# できた zip は helper/.release/mindmap-helper-win-x64-v<版>.zip。版は helper/mindmap-helper.csproj の <Version>。
# GitHub Releases へは、このスクリプトの最後に出すコマンド（gh release create）で上げる
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$helper = Join-Path $root "helper"
$release = Join-Path $helper ".release"
$publish = Join-Path $release "mindmap-helper-win-x64"
$version = ([xml](Get-Content (Join-Path $helper "mindmap-helper.csproj"))).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
if (-not $version) { throw "helper/mindmap-helper.csproj に <Version> が無い" }
$zip = Join-Path $release "mindmap-helper-win-x64-v$version.zip"

& (Join-Path $PSScriptRoot "win-webrtc-apm.ps1")
if ($LASTEXITCODE -ne 0) { throw "webrtc-apm.dll を用意できません" }

if (Test-Path $publish) { Remove-Item -Recurse -Force $publish }
dotnet publish $helper -c Release -r win-x64 --self-contained true -o $publish
if ($LASTEXITCODE -ne 0) { throw "dotnet publish が失敗しました" }

# 配布に要るものがそろっているか（第三者の表示は THIRD_PARTY_NOTICES.md と ADR 0005）
$required = @("mindmap-helper.exe", "webrtc-apm.dll", "sherpa-onnx-c-api.dll", "onnxruntime.dll", "LICENSE", "THIRD_PARTY_NOTICES.md", "LICENSES\webrtc.LICENSE.txt", "LICENSES\webrtc.PATENTS.txt", "LICENSES\abseil-cpp.LICENSE.txt")
$missing = $required | Where-Object { -not (Test-Path (Join-Path $publish $_)) }
if ($missing) { throw "配布物に足りないものがあります: $($missing -join ', ')" }

# 展開先の案内（zip の中に 1 枚）
@"
mindmap-helper $version（Windows x64、.NET ランタイム同梱）

このフォルダの中身を %LOCALAPPDATA%\mindmap\helper に置く（mindmap-helper.exe がそのフォルダの直下に来るように）。
mindmap の server はリポジトリの helper/bin/Release/... に実行ファイルが無いとき、ここを見る。
使い方は https://github.com/tomlinefx/mindmap の README。第三者のライセンス表示は THIRD_PARTY_NOTICES.md と LICENSES/。
"@ | Set-Content -Path (Join-Path $publish "INSTALL.txt") -Encoding UTF8

if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path (Join-Path $publish "*") -DestinationPath $zip
$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "できました: $zip（$size MB）"
Write-Host "GitHub Releases へ上げるには（WSL の gh）: gh release create v$version `"$zip`" --title `"mindmap-helper v$version`" --notes-file <notes.md>"
