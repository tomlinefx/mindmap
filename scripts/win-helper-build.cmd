@echo off
rem ヘルパー（C#）を Release でビルドする（WSL interop から呼ぶ用）。引数は dotnet build にそのまま渡す
cd /d "%~dp0.."
dotnet build -c Release helper %*
