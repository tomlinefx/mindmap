@echo off
rem win-dev.ps1 の cmd ラッパー（WSL interop から呼ぶ用）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0win-dev.ps1" %*
