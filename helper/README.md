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
- `Audio/ProcessLoopbackCapture.cs`: 相手の音。WASAPI の Process Loopback で、会議アプリのプロセス（とその子プロセス）が出す音だけを取る。NAudio に無いので `ActivateAudioInterfaceAsync` を自前で呼ぶ
- `Audio/EchoCancellation.cs`: スピーカー漏れを自分のトラックから消す（WebRTC AEC3 + high-pass filter）。相手の音を参照にして、16 kHz・10 ms ごとに `webrtc-apm.dll` を P/Invoke で呼ぶ。2 つの Capture の時刻（実時間に合わせたサンプル位置）で参照を合わせ、自分の音は 0.15 秒遅らせる
- `native/webrtc-apm/`: `webrtc-apm.dll` の中身。上流 `helper/Sources/CWebRTCAPM` と同じ C のシム（`apm.cpp`）。`scripts/win-webrtc-apm.cmd` が freedesktop の webrtc-audio-processing を上流と同じコミットで静的にビルドして、dll にする
- `Transcription/ITranscriber.cs`: STT の差し口。`SherpaTranscriber.cs` が端末内 STT（sherpa-onnx の日本語 zipformer ＋ silero VAD。途中結果は区間のデコードし直し）。`FakeTranscriber.cs` は音の有無だけで「発言」を作る足場（`MINDMAP_STT=fake`）
- `RunSession.cs`: `run`。2 トラックを取り、STT につなぎ、原点からの秒に直して送る
- `SttFile.cs` / `CaptureFile.cs`: 開発用 `stt-file <wav>`（wav を STT に通して、`run` と同じ形のイベントを JSON の行で出し、RTF を標準エラーに出す）と `capture-wav self|other <秒> <out.wav>`（取得を wav に残す）

## 使い方

```sh
dotnet build -c Release helper                       # 実行ファイルは helper/bin/Release/net10.0-windows/win-x64/mindmap-helper.exe
helper/bin/Release/net10.0-windows/win-x64/mindmap-helper.exe list    # 音を出している会議アプリを JSON で出す
helper/bin/Release/net10.0-windows/win-x64/mindmap-helper.exe check   # マイクの許可・STT のモデルの状態を JSON で出す
helper/bin/Release/net10.0-windows/win-x64/mindmap-helper.exe run --app Zoom.exe --port 8765 [--origin <hostTime>] [--self-manual pause|take] [--vad-silence <秒>]
helper/bin/Release/net10.0-windows/win-x64/mindmap-helper.exe stt-file <wav> [--vad-silence <秒>]   # 開発用。モデルの確認
helper/bin/Release/net10.0-windows/win-x64/mindmap-helper.exe capture-wav other 10 out.wav Zoom.exe   # 開発用。Process Loopback の確認（app id を省くと再生デバイス全体）
helper/bin/Release/net10.0-windows/win-x64/mindmap-helper.exe capture-wav aec 10 out.wav Zoom.exe     # 開発用。エコーキャンセルの確認（out.wav = 消した後、out.mic.wav = 消す前、out.ref.wav = 参照）
```

端末内 STT のモデルは `scripts/win-stt-models.cmd` で `%LOCALAPPDATA%\mindmap\models\stt` に入れる（約 150 MB。`check` の `sttModel` が `installed` になる）。

エコーキャンセルの `webrtc-apm.dll` は `scripts/win-webrtc-apm.cmd` で `helper/.deps/webrtc-apm/lib/` に作る（Visual Studio の「C++ によるデスクトップ開発」が要る。meson と ninja は uv が一時的に用意する）。あれば `dotnet build` が実行ファイルの隣に写す。無くても `run` は動き、エコーキャンセル無しで続ける旨を標準エラーに出す。

- `--app`: `list` の id（実行ファイル名）。そのプロセスの音だけを Process Loopback で取る。PID は音を出しているプロセスを優先し、無ければ同じ名前で最初に始まったもの（子プロセスの音も一緒に取る）。動いていなければ知らせたうえで始め、再生デバイス全体の音を取る。セッションの途中で会議アプリを終了して起動し直すと PID が変わるので、相手の音は届かなくなる（`tap-silent` が出る。セッションの起動し直しで追い直す）
- `--origin`: 起動し直しのとき、server が最初の起動の `origin` の値を渡す。無ければ自分で原点を決める。どちらでも起動直後に `origin` を送る
- `--self-manual`: 起動し直しのとき、server が覚えていた手動の休止の状態
- `--vad-silence`（`run`・`stt-file`）: VAD が区間を閉じる無音の長さ（秒、0 より大きい数）。既定 0.6。端末内 STT（sherpa）だけに効き、偽の STT では使わない。数でないか 0 以下なら終了コード 2
- 環境変数 `LIVE_MINDMAP_HELPER_CONTROL_TOKEN`: server からの指示の合言葉。指示の JSON の `token` と比べる
- 環境変数 `MINDMAP_STT_MODEL`: 端末内 STT のモデルのフォルダ（既定 `%LOCALAPPDATA%\mindmap\models\stt`）
- 環境変数 `MINDMAP_STT=fake`: 偽の STT（音声のパイプラインの確認用）
- 環境変数 `MINDMAP_HELPER_TRACE=<file>`: 送ったイベントを 1 行ずつ追記する（開発用）。`MINDMAP_STT_DUMP=<dir>`: デコードした区間の音声を wav で残す（開発用）

## イベントの形

WebSocket に 1 行の JSON をテキストフレームで流す。全体の形は `server/src/core/live.ts`、ここには起動直後の 2 件と `segment-end` だけ書く。

- `origin`: `{"type":"origin","hostTime":"<数字の文字列>","wallTime":<Unix ms>}`。`hostTime` は `Stopwatch.GetTimestamp()` の原点（64 bit なので文字列）。`wallTime` は原点（音声の時刻 0）に当たる壁時計。起動し直し（`--origin`）でも、受けた原点に当たる壁時計（起動し直した時刻ではない）を添える
- `speaker-off`: `{"type":"speaker-off","start":0,"reason":"モデルなし"}`。話者分離のモデルを持たないことを知らせる。1 回だけ

- `segment-end`: `{"type":"segment-end","track":"自分","start":12.3,"end":15.1}`。VAD が区間を閉じたことを知らせる。その区間の確定結果（`remark`）より先に、デコードを待たずに出すので、確定結果の文字が空で `remark` が出ない区間にも出る。本文は持たない。`start` は同じ区間の確定結果の `start` と同じ揃え方（途中結果を出した区間ならその `start`）、`end` は区間の終わり（先行音声は含まない）。どちらも `remark` と同じく原点からの秒

順序は `origin` → `speaker-off` → 以後の結果（`remark`・`partial`・`segment-end` など）。2 件は音声を取る前に送る。

`stt-file` は `run` と同じ形のイベント（`partial`・`remark`・`segment-end`）を 1 行の JSON で標準出力に出す（トラックは「自分」固定、時刻はトラック内の秒）。RTF は標準エラーに出す。

## 端末内 STT の作り（SherpaTranscriber）

- モデルは非ストリーミングの日本語 zipformer（ReazonSpeech、int8）。silero VAD（しきい値 0.3、無音 0.6 秒で区切り。`--vad-silence` で変える）で区間を切る
- 途中結果: 話し始めから今までの音声を 0.5 秒ごとにデコードし直す（server は途中結果が 1 秒更新されないと発言にするので、1 秒より短く）。確定結果は VAD が閉じた区間で、start は途中結果と同じにする（server が同じ発話として置き換える）
- 待ち行列（Push したがデコードの作業スレッドがまだ取り出していない音声）に 0.3 秒より長い音声がたまっている間は、途中結果のデコードを飛ばす（次の窓でやり直す）。確定結果のデコードは飛ばさない。`stt-file` は wav を実時間より速く流すので、途中結果はほとんど出ない
- デコードする区間の頭には、0.4 秒の先行音声と 0.5 秒の無音を足す。語の途中から始まる音声（会議の途中で取り込みを始めたとき）は、無音が無いとモデルが頭の数秒を落とす（実測）
- 再生デバイスの loopback は何も鳴っていない間サンプルを届けないので、実時間との差を無音で埋めて時刻を合わせる
- モデルの読み込み（2 トラックで約 6 秒）は WebSocket を開く前に済ませる。`cli start` はその分だけ待つ
- 実測（Ryzen 級の CPU、int8、2 トラック同時）: 12 秒の発話の途中結果のデコードし直しに最大 1.8 秒。発話が長いほど途中結果が遅れる

## 終了コード

- 0: 正常。2: 引数の誤り。1: 音声を取れない
- 75: マイクの入力の構成が変わって取得が止まった（server は起動し直す。`server/src/core/intake.ts` の HELPER_EXIT_CONFIGURATION_CHANGED）

server が止めるときは Windows なので SIGTERM は届かず、プロセスはそのまま終了する（録音は初版では無いので、閉じ忘れるものは無い）。

## 未実装（ADR 0001 の順）

1. クラウド STT の実装（差し口だけある）
