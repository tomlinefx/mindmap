# 音声取得と端末内 STT は C# の Windows ヘルパーが行い、server との境界は live-mindmap と同じ WebSocket イベントにする

元プロジェクト live-mindmap のヘルパーは Swift で、Core Audio のプロセスタップ・SpeechAnalyzer・Apple Intelligence に依存して macOS でしか動かない（上流 ADR 0002）。この製品はヘルパーを C# / .NET 10 で書き直し、相手の声は WASAPI の Process Loopback（会議アプリのプロセスの音だけ）、自分の声はマイクから取り、スピーカー漏れは上流と同じ WebRTC AEC3（C のシムを P/Invoke）で消す。端末内 STT は sherpa-onnx の日本語 Zipformer（ReazonSpeech、`sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01` の int8）。sherpa-onnx には日本語のストリーミングモデルが無い（2026-10 時点で streaming zipformer は中英韓仏など。日本語は非ストリーミングだけ）ので、silero VAD で区間を切り、話している最中の区間を 0.5 秒ごとにデコードし直して途中結果に（server は途中結果が 1 秒更新されないと発言にするので、それより短く）、VAD が閉じた区間をデコードして確定結果にする。デコードする区間の頭には 0.4 秒の先行音声と 0.5 秒の無音を足す（語の途中から始まる音声は、無音が無いとモデルが頭の数秒を落とす。実測）。実測（CPU、int8）は RTF 0.03〜0.11 で、上流が SpeechAnalyzer を選んだ理由（途中結果がすぐ出る・境界で語が欠けない）を実用上は満たす。whisper.cpp は VAD で切っても途中結果の出し直しが重く、選ばない。

ヘルパーと server の境界は、上流の `helper/Sources/HelperCore/Events.swift` と同じ localhost の WebSocket と JSON（`remark` / `partial` / `origin` / `self-pause` など）に保つ。そのため server/web は上流のものをほぼそのまま使え、Mac に結びつく部分（ビルドコマンド・`check` の項目・会議アプリの識別子）だけを変える。

## Transcriber の差し口と出力の粒度

`Transcriber` は音声のフレームを受け取り、上流の `TranscriptionResult` と同じ `{ text, isFinal, start, end, wordTimes }` を流す。`words`（語の区切りと読み）は Transcriber の責務ではなく、上流と同じくヘルパーが本文から別に作る。

- `wordTimes`: エンジンが時刻を付ける最小の単位。端末内 STT（sherpa-onnx）では Zipformer のトークン（確定結果にだけ付ける）、クラウド STT では語。`location` / `length` は本文の UTF-16 コード単位、`start` / `end` は会議の原点からの秒。本文の中で重ならず、`location` の昇順。時刻を持たないエンジンでは空の配列。server はこれを字幕の語ごとの出し分け（`captions.ts`）にだけ使い、無くても動く
- `words`: 消費者は語彙補正（上流 `correction.ts` / `vocabularyPool.ts`）だけで、初版の範囲外なので、初版のヘルパーは空の配列を送る。足すときは、日本語の分かち書きと読み（上流は CFStringTokenizer のローマ字）をヘルパーで作る。Transcriber の差し替えとは独立

## server 側の修正（ヘルパーをつなぐために必ず触るもの）

- `server/src/helperPath.ts`: 既定の実行ファイルの場所と、無いときに示すビルドのコマンド（`swift build` → `dotnet build`）
- `server/src/helpers.ts`: `check` の JSON の形（`microphone` の 3 値・`speechJa`・`screenCapture` → マイクの許可と STT モデルの有無）。`installSpeechJa`・`creationDate`・`--no-screen` は要らなくなる
- `server/src/sessions.ts`: `run` に渡す引数（`--app` の値・`--audio-dir` / `--audio-index`・`--no-screen`・`--self-*` の引き継ぎ）を、新ヘルパーが受けるものだけにする
- `server/src/cli.ts` と `apps` の経路: `--app` の説明と `list` の出力の形（bundle id → プロセス名と PID）
- `server/src/core/intake.ts`: ヘルパーの終了コード（`microphoneConfigurationChangedExitCode` など）の値を新ヘルパーと揃える

## Consequences

- ヘルパーは Windows 10 2004 以降（Process Loopback）を前提にする。macOS・Linux では動かない
- APM で有効にするのは上流と同じ AEC3 と high-pass filter だけ（上流の `apm.cpp` は NS・AGC1・AGC2 を無効にしている）。機能は減らさず、増やしもしない
- クラウド STT は初版では差し口だけを用意する。sherpa-onnx の hotwords（語彙の優先）も初版では使わず、語彙補正と一緒に後で足す
- 途中結果はここまでの区間をデコードし直すので、発話が長いほど遅れる（12 秒で最大 1.8 秒）。VAD は区間を 12 秒で強制的に閉じる。モデルの読み込み（2 トラックで約 6 秒）は WebSocket を開く前に済ませるので、`start` はその分だけ待つ
- 話者分離（上流 ADR 0013）・共有画面（上流 ADR 0011）・録音ファイル・自分の休止の自動判定は初版では作らない。イベントの形は上流のまま保ち、後から足せるようにする
