---
name: mindmap-stop
description: 会議のセッションを終了して map.md などを書き出し、その場所を伝える。Use when the user wants to end the meeting mapping.
allowed-tools: PowerShell, Bash, Read
argument-hint: [-StopServer]
---

# mindmap-stop

会議の終了。`scripts\win-meeting-stop.cmd` を呼ぶだけで、中身はそのスクリプトが正本。

1. PowerShell ツールで実行する: `& "C:\Users\takah\projects\mindmap\scripts\win-meeting-stop.cmd" $ARGUMENTS`
   - `-StopServer` を付けると、常駐サーバーと画面も止める（既定は次の会議のために残す）
2. 書き出したファイルの場所（map.md・map.json・map.drawnix・map.html）をそのまま伝える。利用者が内容を知りたければ map.md を読んで要点（決定・TODO・未決の論点・アウトライン）を短く伝える
3. 「セッションがありません」で失敗したら、もう終わっているか始めていないかなので、そのまま伝える
