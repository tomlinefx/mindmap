# WebRTC AEC3 のシム webrtc-apm.dll を helper/.deps/webrtc-apm/lib/ に作る（helper/README.md、ADR 0001）。上流 helper/scripts/build-webrtc-apm.sh の Windows 版。
#   1. freedesktop の webrtc-audio-processing を上流と同じ固定のコミットで取り、meson（uv で一時的に使う）と MSVC で静的ライブラリにビルドする
#   2. helper/native/webrtc-apm/apm.cpp をコンパイルし、静的ライブラリと一緒に webrtc-apm.dll にリンクする（CRT は静的。利用者の PC に VC ランタイムが無くても動く）
# 必要なもの: Visual Studio の「C++ によるデスクトップ開発」（MSVC と Windows SDK）、git。すでに dll があれば何もしない（-Force で作り直す）。
# できた dll は helper のビルド（dotnet build）が実行ファイルの隣に写す
param([switch]$Force)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$deps = Join-Path $root "helper\.deps"
$apm = Join-Path $deps "webrtc-apm"
$src = Join-Path $apm "src"
$build = Join-Path $apm "build"
$lib = Join-Path $apm "lib"
$dll = Join-Path $lib "webrtc-apm.dll"
$native = Join-Path $root "helper\native\webrtc-apm"
$RepoUrl = "https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing.git"
$Commit = "d0569cfa50c1858ee279d77b3fc8870be6902441" # v2.1 の後。上流が #110 でビルドと効き目を確かめた版
$UvUrl = "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip"

if ((Test-Path $dll) -and -not $Force) { Write-Host "webrtc-apm: already built ($dll)"; exit 0 }

# MSVC の環境（vcvars64.bat）。vswhere で VC ツールの入った VS を探す
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = if (Test-Path $vswhere) { & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath } else { $null }
$vcvars = if ($vs) { Join-Path $vs "VC\Auxiliary\Build\vcvars64.bat" } else { $null }
if (-not $vcvars -or -not (Test-Path $vcvars)) { throw "MSVC が見つかりません。Visual Studio Installer で「C++ によるデスクトップ開発」（MSVC と Windows SDK）を入れる" }

# uv（meson と ninja を一時的に使うため。Python も uv が用意する）
$uv = Join-Path $deps "uv\uv.exe"
if (-not (Test-Path $uv)) {
  Write-Host "uv を取得しています..."
  New-Item -ItemType Directory -Force (Split-Path $uv) | Out-Null
  $zip = Join-Path $env:TEMP "uv-windows.zip"
  Invoke-WebRequest -Uri $UvUrl -OutFile $zip
  Expand-Archive -Force $zip (Split-Path $uv)
  Remove-Item -Force $zip
}

# ソース（固定のコミット）
New-Item -ItemType Directory -Force $apm | Out-Null
if (-not (Test-Path (Join-Path $src ".git"))) { git init -q $src }
$head = git -C $src rev-parse --verify --quiet HEAD
if ($head -ne $Commit) {
  git -C $src fetch --depth 1 $RepoUrl $Commit
  if ($LASTEXITCODE -ne 0) { throw "ソースを取れません: $RepoUrl $Commit" }
  git -C $src checkout -q --force FETCH_HEAD
}

# vcvars64 を通した cmd の中で実行する（PowerShell には環境が戻らないので、1 コマンドずつ cmd に渡す）
function Invoke-Vc([string]$command) {
  cmd /c "call `"$vcvars`" >nul && $command"
  if ($LASTEXITCODE -ne 0) { throw "失敗しました: $command" }
}

$meson = "`"$uv`" tool run --from meson --with ninja meson"
if (Test-Path $build) { Remove-Item -Recurse -Force $build }
# cpp_std は c++20。MSVC は指定初期化子（agc2/input_volume_stats_reporter.cc）を C++17 では受け付けない（上流の既定は c++17。clang/gcc は拡張として通す）
Invoke-Vc "$meson setup `"$build`" `"$src`" --default-library=static --buildtype=release -Dcpp_std=c++20 -Db_vscrt=mt -Dabseil-cpp:default_library=static"
Invoke-Vc "$meson compile -C `"$build`""

# 静的ライブラリを lib/ に平らに集める
if (Test-Path $lib) { Remove-Item -Recurse -Force $lib }
New-Item -ItemType Directory -Force $lib | Out-Null
Get-ChildItem $build -Recurse -Include *.a, *.lib | Where-Object { $_.FullName -notmatch '\\examples\\' } | Copy-Item -Destination $lib
$abseil = Get-ChildItem (Join-Path $src "subprojects") -Directory -Filter "abseil-cpp*" | Select-Object -First 1
if (-not $abseil) { throw "abseil-cpp の subproject が $src\subprojects に無い" }

# シム → webrtc-apm.dll。定義は webrtc-audio-processing の meson.build の Windows 向けと同じ（WEBRTC_LIBRARY_IMPL / WEBRTC_ENABLE_SYMBOL_EXPORT は静的リンクなので付けない）
$libs = (Get-ChildItem $lib -Include *.a, *.lib -Recurse | ForEach-Object { "`"$($_.FullName)`"" }) -join " "
$defines = "/DWEBRTC_WIN /D_WIN32 /DNOMINMAX /D_USE_MATH_DEFINES /D_WINSOCKAPI_ /DNDEBUG /DWEBRTC_APM_DEBUG_DUMP=0"
$includes = "/I`"$src`" /I`"$src\webrtc`" /I`"$build`" /I`"$($abseil.FullName)`""
Invoke-Vc "cl /nologo /O2 /MT /EHsc /std:c++20 /utf-8 $defines $includes /LD `"$native\apm.cpp`" /Fo`"$build\apm.obj`" /Fe`"$dll`" /link $libs winmm.lib"
Write-Host "webrtc-apm: built $dll"
