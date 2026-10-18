@echo off
rem server の型検査だけを Windows 側の tsc で走らせる（WSL interop から呼ぶ用）。引数は tsc にそのまま渡す
set "PATH=C:\Program Files\nodejs;%APPDATA%\npm;%PATH%"
cd /d "%~dp0..\server"
call node_modules\.bin\tsc.cmd --noEmit %*
