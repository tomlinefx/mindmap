@echo off
rem win-stt-models.ps1 の cmd ラッパー（WSL interop から呼ぶ用）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0win-stt-models.ps1" %*
