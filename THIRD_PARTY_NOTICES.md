# 第三者のコードとモデルの表示

このリポジトリと、ビルドしてできる実行ファイル（`helper/bin/…/mindmap-helper.exe` とその隣）に含まれる第三者のものと、そのライセンス。
全体の方針は [docs/adr/0005-license-mit-with-third-party-notices.md](docs/adr/0005-license-mit-with-third-party-notices.md)。

## リポジトリに含まれているもの（ソースの配布で表示が要る）

| もの | 置き場 | 権利者 | ライセンス | 表示 |
|---|---|---|---|---|
| live-mindmap（元プロジェクト） | `server/`、`web/`、`helper/native/webrtc-apm/`（apm.cpp）、`docs/adr/upstream/`、`CONTEXT.md`（GLOSSARY.md を元に書き直し） | Daiki Beppu | MIT | [LICENSE](LICENSE) にそのままの著作権表示と許諾文を残す |
| video.js のアイコン | `web/src/app/review/icons.ts` | Video.js contributors | Apache-2.0 | [web/src/app/review/icons.NOTICE.md](web/src/app/review/icons.NOTICE.md) に全文 |

## ビルド・実行時に取り込むもの（バイナリの配布で表示が要る）

リポジトリには入っていない。`pnpm install`・`dotnet build`・`scripts/win-webrtc-apm.cmd`・`scripts/win-stt-models.cmd` が利用者の PC に取り込む。
実行ファイルを配るときは、下の表示を一緒に配る（`dotnet build` が `LICENSE`・この文書・`LICENSES/` を実行ファイルの隣に写す）。

| もの | 入り方 | 権利者 | ライセンス | 表示の文書 |
|---|---|---|---|---|
| WebRTC（audio_processing、AEC3） | `webrtc-apm.dll` に静的リンク（`scripts/win-webrtc-apm.cmd`） | The WebRTC project authors / Google Inc. | BSD-3-Clause ＋ 特許の許諾（PATENTS） | `helper/.deps/webrtc-apm/lib/LICENSES/webrtc.LICENSE.txt`、`webrtc.PATENTS.txt`、`webrtc-audio-processing.COPYING.txt` |
| abseil-cpp | 同上 | The Abseil Authors | Apache-2.0 | `LICENSES/abseil-cpp.LICENSE.txt` |
| pffft | 同上 | Julien Pommier（FFTPACK を元にする） | FFTPACK ライセンス（BSD 系） | `LICENSES/pffft.LICENSE.txt` |
| rnnoise | 同上 | Mozilla、Jean-Marc Valin、Xiph.Org Foundation ほか | BSD-3-Clause | `LICENSES/rnnoise.COPYING.txt` |
| sherpa-onnx（`sherpa-onnx-c-api.dll`） | NuGet `org.k2fsa.sherpa.onnx` | Xiaomi Corporation | Apache-2.0 | https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE |
| ONNX Runtime（`onnxruntime.dll`） | sherpa-onnx の NuGet に同梱 | Microsoft Corporation | MIT | https://github.com/microsoft/onnxruntime/blob/main/LICENSE |
| NAudio | NuGet `NAudio` 2.2.1 | Mark Heath | MIT | https://github.com/naudio/NAudio/blob/master/license.txt |
| 日本語の音声認識モデル（`sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01`） | `scripts/win-stt-models.cmd` が `%LOCALAPPDATA%\mindmap\models\stt` に置く（配布物には含めない） | Reazon Human Interaction Lab（元は `reazonspeech-k2-v2`。sherpa-onnx が ONNX に変換） | Apache-2.0 | https://huggingface.co/reazon-research/reazonspeech-k2-v2 |
| silero VAD（`silero_vad.onnx`） | 同上 | Silero Team | MIT（リポジトリの LICENSE。重みに別のライセンスの記載は無い） | https://github.com/snakers4/silero-vad/blob/master/LICENSE |
| Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`） | `pnpm install`（server の依存） | Anthropic | Anthropic の規約（オープンソースではない） | 同梱せず npm から入れる。認証は利用者の API キー（上流 ADR 0004） |
| web の npm 依存（Foldkit、effect ほか） | `pnpm install`。見返し用の `map.html` に bundle される | 各権利者 | MIT ほか | `map.html` の書き出し時に Vite が bundle したモジュールのライセンスを HTML 内に埋め込む（`server/src/review.ts`） |

## 守っていること

- MIT（live-mindmap・NAudio・ONNX Runtime・silero VAD）: 著作権表示と許諾文を、ソースと配布物に残す
- BSD-3-Clause（WebRTC・rnnoise）・FFTPACK（pffft）: バイナリを配るときに、著作権表示・条件・免責を一緒に配る（`LICENSES/`）。Google や権利者の名前を宣伝に使わない
- Apache-2.0（abseil・sherpa-onnx・ReazonSpeech のモデル）: ライセンス全文を一緒に配る。NOTICE ファイルを持つものがあればそれも配る（いまの対象には無い）
- 音声認識のモデルは配布物に含めず、利用者が自分で取得する（`scripts/win-stt-models.cmd`）

## 変えるときに

- 依存を足したら、この表に 1 行足し、バイナリに入るものなら `LICENSES/` へ写す段取り（`scripts/win-webrtc-apm.ps1`・`helper/mindmap-helper.csproj`）も足す
- 配布の形（インストーラー・zip）を作るときは、`LICENSE`・この文書・`LICENSES/` が入っていることを確かめる
