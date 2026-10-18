@echo off
rem win-webrtc-apm.ps1 の cmd ラッパー。WSL interop から呼ぶ用
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0win-webrtc-apm.ps1" %*
