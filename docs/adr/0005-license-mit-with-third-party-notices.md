# 全体を MIT で出し、元プロジェクトの著作権表示を残し、バイナリに入る第三者の表示を同梱する

この製品は live-mindmap（MIT、Copyright (c) 2026 Daiki Beppu）の server と web をコピーし、helper を C# で書き直したもの（ADR 0001・0002）。MIT の条件は「著作権表示と許諾文をコピーに含める」ことなので、`LICENSE` に上流の表示をそのまま残し、その下に新しく書いた部分の著作権表示を足す。全体のライセンスは上流と同じ MIT にする（上流 ADR 0004 の「MIT で受けて MIT で出す」に合わせる。別のライセンスにする理由が無い）。

helper は WebRTC（BSD-3-Clause ＋ PATENTS）・abseil（Apache-2.0）・pffft・rnnoise を `webrtc-apm.dll` に静的リンクし、sherpa-onnx（Apache-2.0）・ONNX Runtime（MIT）・NAudio（MIT）の dll を隣に置く。これらはソースを配るだけなら表示は要らないが、実行ファイルを配ると「著作権表示・条件・免責を一緒に配る」義務が生じる。配るかどうかを後で決めても困らないよう、ビルドの段階で表示を同梱する: `scripts/win-webrtc-apm.cmd` が静的リンクした各ライセンスの全文を `helper/.deps/webrtc-apm/lib/LICENSES/` に集め、`dotnet build` が `LICENSE`・`THIRD_PARTY_NOTICES.md`・`LICENSES/` を実行ファイルの隣に写す。一覧と出どころは `THIRD_PARTY_NOTICES.md` が正本。

音声認識のモデル（ReazonSpeech、Apache-2.0）と silero VAD（MIT）は配布物に含めず、利用者が `scripts/win-stt-models.cmd` で取得する。Claude Agent SDK はオープンソースではないので同梱せず、認証は利用者の API キーで行う（上流 ADR 0004 と同じ）。

## Consequences

- 依存を足すときは `THIRD_PARTY_NOTICES.md` に 1 行足す。バイナリに入るものなら `LICENSES/` へ写す段取りも足す
- リポジトリを public にする前に、上流の `docs/publishing.md` と同じ点検（シークレット・会議の音声や文字起こしが履歴に無いこと）を行う
- 配布の形（zip・インストーラー）を作るときは、`LICENSE`・`THIRD_PARTY_NOTICES.md`・`LICENSES/` を含める
