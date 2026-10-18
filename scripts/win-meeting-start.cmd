@echo off
rem win-meeting-start.ps1 の cmd ラッパー。引数はそのまま渡す (例: win-meeting-start.cmd Zoom.exe "週次定例")
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0win-meeting-start.ps1" %*
