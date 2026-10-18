# helper

会議の音声を文字起こしして発言を server へ流す C# のヘルパー（ADR 0001）。Windows 専用。server が子プロセスとして起動する。

前提: .NET 10 SDK、Windows 10 2004 以降。

## 構成

- `Program.cs`: 引数の解釈と配線だけ
- `Events.cs`: WebSocket に流すイベントの形（上流 `helper/Sources/HelperCore/Events.swift` と同じ JSON。server は `server/src/core/live.ts` で読む）
- `WebSocketServer.cs`: 127.0.0.1 の 1 ポートで server の接続を 1 つ受ける。server からの指示（`self-pause`）も受ける
- `Apps.cs`: `list`。既定の再生デバイスで音を出しているプロセスを、実行ファイル名を id にして出す
- `Check.cs`: `check`。マイクの許可（Windows のプライバシー設定）と端末内 STT のモデルの有無
- `Audio/Capture.cs`: 1 トラック分の取得。WASAPI の形式を 16 kHz モノラルの float にする
- `Transcription/ITranscriber.cs`: STT の差し口。`SherpaTranscriber.cs` が端末内 STT（sherpa-onnx の日本語 zipformer ＋ silero VAD。途中結果は区間のデコードし直し）。`FakeTranscriber.cs` は音の有無だけで「発言」を作る足場（`MINDMAP_STT=fake`）
- `RunSession.cs`: `run`。2 トラックを取り、STT につなぎ、原点からの秒に直して送る
- `SttFile.cs` / `CaptureFile.cs`: 開発用 `stt-file <wav>`（wav を STT に通して結果と RTF を出す）と `capture-wav self|other <秒> <out.wav>`（取得を wav に残す）

## 使い方

```sh
dotnet build -c Release helper                       # 実行ファイルは helper/bin/Release/net10.0-windows/win-x64/mindmap-helper.exe
helper/bin/Release/net10.0-windows/win-x64/mindmap-helper.exe list    # 音を出している会議アプリを JSON で出す
helper/bin/Release/net10.0-windows/win-x64/mindmap-helper.exe check   # マイクの許可・STT のモデルの状態を JSON で出す
helper/bin/Release/net10.0-windows/win-x64/mindmap-helper.exe run --app Zoom.exe --port 8765 [--origin <hostTime>] [--self-manual pause|take]
helper/bin/Release/net10.0-windows/win-x64/mindmap-helper.exe stt-file <wav>   # 開発用。モデルの確認
```

端末内 STT のモデルは `scripts/win-stt-models.cmd` で `%LOCALAPPDATA%\mindmap\models\stt` に入れる（約 150 MB。`check` の `sttModel` が `installed` になる）。

- `--app`: `list` の id（実行ファイル名）。動いていなくても始まる（いまは再生デバイス全体の音を取るため）
- `--origin`: 起動し直しのとき、server が最初の起動の `origin` の値を渡す。無ければ自分で原点を決めて `origin` を送る
- `--self-manual`: 起動し直しのとき、server が覚えていた手動の休止の状態
- 環境変数 `LIVE_MINDMAP_HELPER_CONTROL_TOKEN`: server からの指示の合言葉。指示の JSON の `token` と比べる
- 環境変数 `MINDMAP_STT_MODEL`: 端末内 STT のモデルのフォルダ（既定 `%LOCALAPPDATA%\mindmap\models\stt`）
- 環境変数 `MINDMAP_STT=fake`: 偽の STT（音声のパイプラインの確認用）
- 環境変数 `MINDMAP_HELPER_TRACE=<file>`: 送ったイベントを 1 行ずつ追記する（開発用）。`MINDMAP_STT_DUMP=<dir>`: デコードした区間の音声を wav で残す（開発用）

## 端末内 STT の作り（SherpaTranscriber）

- モデルは非ストリーミングの日本語 zipformer（ReazonSpeech、int8）。silero VAD（しきい値 0.3、無音 0.6 秒で区切り）で区間を切る
- 途中結果: 話し始めから今までの音声を 0.5 秒ごとにデコードし直す（server は途中結果が 1 秒更新されないと発言にするので、1 秒より短く）。確定結果は VAD が閉じた区間で、start は途中結果と同じにする（server が同じ発話として置き換える）
- デコードする区間の頭には、0.4 秒の先行音声と 0.5 秒の無音を足す。語の途中から始まる音声（会議の途中で取り込みを始めたとき）は、無音が無いとモデルが頭の数秒を落とす（実測）
- 再生デバイスの loopback は何も鳴っていない間サンプルを届けないので、実時間との差を無音で埋めて時刻を合わせる
- モデルの読み込み（2 トラックで約 6 秒）は WebSocket を開く前に済ませる。`cli start` はその分だけ待つ
- 実測（Ryzen 級の CPU、int8、2 トラック同時）: 12 秒の発話の途中結果のデコードし直しに最大 1.8 秒。発話が長いほど途中結果が遅れる

## 終了コード

- 0: 正常。2: 引数の誤り。1: 音声を取れない
- 75: マイクの入力の構成が変わって取得が止まった（server は起動し直す。`server/src/core/intake.ts` の HELPER_EXIT_CONFIGURATION_CHANGED）

server が止めるときは Windows なので SIGTERM は届かず、プロセスはそのまま終了する（録音は初版では無いので、閉じ忘れるものは無い）。

## 未実装（ADR 0001 の順）

1. 相手の音を会議アプリのプロセスだけから取る（WASAPI Process Loopback）。いまは既定の再生デバイス全体の loopback
2. エコーキャンセル（WebRTC AEC3 + high-pass filter）。スピーカーで聞いたときの相手の声の漏れを、自分のトラックから消す
3. クラウド STT の実装（差し口だけある）
