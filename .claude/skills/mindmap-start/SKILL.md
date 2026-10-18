---
name: mindmap-start
description: 会議のセッションを 1 コマンドで開始する（サーバーと画面の起動・会議アプリの選択・閲覧の共有・ブラウザまで）。Use when the user wants to start mapping a meeting.
allowed-tools: PowerShell, Bash
argument-hint: [app id（例 Zoom.exe）] [会議名]
---

# mindmap-start

会議の開始。`scripts\win-meeting-start.cmd` を呼ぶだけで、中身はそのスクリプトが正本（コメントに使い方がある）。

1. PowerShell ツールで実行する: `& "C:\Users\takah\projects\mindmap\scripts\win-meeting-start.cmd" $ARGUMENTS`
   - 引数が無ければ、音を出している会議アプリを自動で選ぶ。exit 2 で候補が出たら、その候補を利用者に見せてどれにするか聞き、選ばれた id を引数にしてもう一度実行する
   - WSL から呼ぶときは `cmd.exe /c` で `run_in_background`（サーバーの起動が interop の標準出力を待つため）
2. 出力をそのまま利用者に伝える: セッションのフォルダ、Android 用の URL（PIN 付き。Wi-Fi と Tailscale の 2 つ）、終わり方（`/mindmap-stop`）
3. 失敗したときは、標準エラーの文面をそのまま伝える。よくある原因: セッションが進行中（先に `/mindmap-stop`）、会議アプリが起動していない、サーバーが起きない（`.dev\server.err.log`）
