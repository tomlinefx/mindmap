@echo off
rem win-release-helper.ps1 の cmd ラッパー。ビルド済みの helper の zip を helper\.release に作る
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0win-release-helper.ps1" %*
