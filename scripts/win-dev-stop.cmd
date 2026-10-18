@echo off
rem win-dev-stop.ps1 の cmd ラッパー（WSL interop から呼ぶ用）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0win-dev-stop.ps1" %*
