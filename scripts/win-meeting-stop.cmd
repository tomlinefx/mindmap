@echo off
rem win-meeting-stop.ps1 の cmd ラッパー。-StopServer でサーバーと画面も止める
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0win-meeting-stop.ps1" %*
