@echo off
rem Windows 側の pnpm を、Node と npm のグローバルを PATH に足してリポのルートで実行する（WSL interop から呼ぶ用）
set "PATH=C:\Program Files\nodejs;%APPDATA%\npm;%PATH%"
cd /d "%~dp0.."
pnpm %*
