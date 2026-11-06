# Research & Design Decisions

---
**Purpose**: phone-recording の設計に効いた調査と、設計判断の理由を残す。`design.md` は、ここを読まなくても成り立つように書いてある。

---

## Summary
- **Feature**: `phone-recording`
- **Discovery Scope**: Complex Integration（新しい入力経路。サーバー・web・C# の 3 つに触れる）
- **Key Findings**:
  - **Android Chrome は、画面オフ・ロックでマイクが無音になるという報告が多い。** 画面オフで録り続けられるとする一次情報は見つからなかった（確度 約 70%）。要件 1.4 は、実機の検証（最初のタスク）の結果に依存する。サーバー側の契約は、録音するもの（ページでもネイティブのラッパーでも）に依存しないように決める
  - **音は PCM（Int16、16 kHz、モノラル）の断片で送る。** MediaRecorder の WebM は、最初の断片にしかヘッダーが無く、断片が単独で読めない。PCM なら 32 KB/s（2 時間で約 230 MB）で、断片が単独で意味を持ち、再送も欠けの判定も単純になり、サーバーでデコードが要らない
  - **文字起こしは、ヘルパーの `stt-file` を切り出した C# の実行ファイルを、子プロセスで呼ぶ。** `org.k2fsa.sherpa.onnx` 1.13.8 は linux-x64 / linux-arm64 のネイティブ版を依存に持つ（NuGet の表で確認）。VAD の閾値・先行音声・語の時刻など、調整済みのコードをそのまま使える
  - 既存コードでは、`recordPlayback` が `cli.ts` の非公開関数で、操作の口を自分で開くので、サーバーの中から呼べない。取り込みの途切れは log.jsonl の `intake-*` と画面の状態にだけあり、map.md・map.json には出ない。`Track` は `自分`/`相手` の 2 値の Schema で、13 ファイルが触れる

## Research Log

### Android Chrome の画面オフ・ロック中のマイク
- **Context**: 要件 1.4（画面オフ・ロック中も録音を続ける）の実現可能性
- **Sources Consulted**:
  - https://issues.chromium.org/issues/331092194 （要サインイン。検索結果の要約のみ）
  - https://github.com/w3c/mediacapture-main/issues/670
  - https://codereview.chromium.org/2263373003
  - https://community.brave.com/t/bug-microphone-wont-work-when-the-app-is-in-the-background-minimized/539007
  - https://progressier.com/pwa-capabilities/screen-wake-lock
- **Findings**:
  - 画面ロックでマイクを止めるのは、プライバシーのための Chromium 側の仕様という報告が複数ある。録音オブジェクトは動き続けても、音が無音になる
  - Screen Wake Lock は画面を点けておくだけで、タブが隠れると自動で解除される。無音の audio 要素や Media Session で延命できるという一次情報は見つからなかった（俗説の扱い）
  - 1〜2 時間の録音の実例は見つからなかった。PWA にしても挙動が変わるという証拠もない
- **Implications**:
  - 既定の動かし方は「画面を点けたまま、Wake Lock を取り、充電しながら伏せて置く」。ページ側は `visibilitychange` で Wake Lock を取り直し、`track.onmute`・`readyState`・音量（AudioWorklet）で無音を検知して画面に出す
  - 画面オフで録れるかは、実機で 30〜60 分の検証をして決める（go/no-go）。足りなければ、同じアップロードの契約を使う薄いネイティブのアプリ（フォアグラウンドサービス）に替える。サーバー側の設計はどちらでも変わらない

### 音の形式と断片
- **Sources Consulted**: https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/start 、https://github.com/w3c/mediacapture-record/issues/195 、https://blog.addpipe.com/media-recorder-api-is-now-supported-by-65-of-all-desktop-internet-users/
- **Findings**: `timeslice` の間隔は目安。WebM の断片は最初の断片のヘッダーが無いと読めない。Chrome の MP4 は断片化されていて、境界が timeslice と揃わない。Android の `isTypeSupported` の結果は実機で確かめる必要がある（未確認）
- **Implications**: AudioWorklet で 16 kHz の Int16 PCM を作り、連番付きの断片（10 秒）で送る。断片ごとに開始サンプルを持つので、欠けた区間を断片の連番と範囲の両方から数えられる

### スマホ側の保持と再送
- **Sources Consulted**: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria 、https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API
- **Findings**: Chrome の保存の上限は、ディスクの 60% まで（オリジン単位）。追い出しは容量が逼迫したときだけ。Background Sync は限定的な対応で、ページが死んでいれば使えない（録音にはページが生きている必要がある）
- **Implications**: 断片を IndexedDB に書いてから送り、サーバーの受領を見て消す。ページが生きている間の再送ループ（指数バックオフ + `online` イベント）で足りる。`navigator.storage.persist()` を要求する。Background Sync は使わない

### 安全な接続（マイクの条件）
- **Sources Consulted**: https://tailscale.com/kb/1242/tailscale-serve 、https://tailscale.com/kb/1153/enabling-https
- **Findings**: `getUserMedia` は安全な接続（https か localhost）でだけ使える。`tailscale serve --bg` で、tailnet の名前に自動の証明書（Let's Encrypt）付きの HTTPS を張り、127.0.0.1 の口へ中継できる。証明書の更新を `serve` が自動でするかはドキュメントに書かれていない。機器の名前が証明書の透明性ログに載る
- **Implications**: 録音の口を 127.0.0.1 に結び、`tailscale serve` で外へ出す運用にすると、LAN には一切開かない。コードに Tailscale 固有の処理は入れない（ADR 0003）。中継は TLS を終えるので、サーバーから見ると http で届く。Origin の検査はスキームを見ない

### サーバー側のデコード
- **Findings**: PCM で受ければデコーダーは要らない（Int16 を WAV に並べるだけ）。ffmpeg は、WebM/MP4 を受けるときの定番だが、この設計では持ち込まない
- **Implications**: 依存を増やさない。WAV のヘッダーは自前で書く（44 バイト）

### sherpa-onnx（Linux、Node）
- **Sources Consulted**: https://www.nuget.org/packages/org.k2fsa.sherpa.onnx/1.13.8 、https://registry.npmjs.org/sherpa-onnx-node 、https://github.com/k2-fsa/sherpa-onnx/tree/master/nodejs-addon-examples
- **Findings**: NuGet 1.13.8 は linux-x64 / linux-arm64 を含む多数の RID のランタイムを依存に持つ。最新は 2.0.0（2026-10-23、変更内容は未確認）。Node の `sherpa-onnx-node` は OfflineRecognizer と Vad を持つが、日本語の transducer + VAD の組み合わせの例は確認できなかった
- **Implications**: C# の実行ファイル案を採る。1.13.8 に固定し、2.0.0 への更新は別の作業にする。Linux の glibc への適合は実機で確かめる

### 既存コード（探索の要点）
- `recordPlayback`（`cli.ts:286`）は非公開で、`play` は操作の口を自分で開く。再利用できる公開の部品は `createSessionDir`、`openLoggedSession`、`writeSessionExports`、`playback`
- 同時 1 セッションの制約は `Sessions`（`sessions.ts:90-94`）の状態機械（`idle | starting | live | stopping`）で、ロックではない。`Live` はヘルパー前提の形
- 操作の口は 127.0.0.1 固定。閲覧の口は `openViewingPort`（全インターフェース、PIN、Cookie、Origin の検査）。バイナリの本文を受ける既存の口は無い
- `helper/SttFile.cs` が `Resampler`（`Capture.cs` の中、`Capture.TargetRate` を参照）と `Check.ModelDirectory` に依存する。`SherpaTranscriber` が NAudio を使うのは、開発用のダンプ（`WaveFileWriter`、NAudio.Core にある）だけ
- 取り込みの途切れの記録は log.jsonl の `intake-*`（復元は知らない種類として読み飛ばす）と画面の状態だけ。エクスポート（`JsonExport`、`exportFiles`）には出ない

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| A: 録音の口 + 子プロセスの STT（採用） | 録音専用の口と状態機械を server に足し、文字起こしは C# の実行ファイルを子プロセスで呼ぶ | 調整済みの STT を流用。クラッシュが分離される。ヘルパーの `Sessions` に触れない | .NET の実行環境がサーバーに要る | helpers.ts の子プロセスの作りと同じ |
| B: Node で sherpa-onnx-node | STT も Node に載せる | 実行環境が Node だけ | VAD の調整を TS で書き直し。日本語 transducer の動作が未確認。メインスレッドを塞ぐ | 却下（未検証が多い） |
| C: `Sessions` を広げて録音を `Live` の一種にする | 既存の状態機械に載せる | 1 つの状態に集まる | `status`・`resume`・`setSelfPause` など `Live` を読む箇所が全部分岐する | 却下（影響が広い）。代わりに共有の `SessionSlot` だけ足す |
| D: 録音の口を既存の閲覧の口に足す | 口を増やさない | 口が少ない | 閲覧の PIN と操作の認証が混ざる（要件 1.6〜1.8 に反する） | 却下 |

## Design Decisions

### Decision: 音は PCM（Int16、16 kHz）の連番付き断片で送る
- **Context**: 断片が欠けても、再送しても、サーバーが同じ結果にならないといけない（要件 4、5、6）
- **Alternatives Considered**:
  1. MediaRecorder の WebM/Opus — 小さいが、断片が単独で読めず、ffmpeg が要る
  2. AudioWorklet の PCM — 大きいが（32 KB/s）、tailnet では問題にならない
- **Selected Approach**: PCM。10 秒の断片に連番と開始サンプルを付け、`PUT` を冪等にする
- **Rationale**: 欠けの判定と再送が単純で、デコードの依存が無い
- **Trade-offs**: 通信量が約 10 倍（2 時間で約 230 MB）。Wi-Fi か tailnet 前提
- **Follow-up**: AudioWorklet が画面ロックで止まる可能性は、実機の検証（Task 1）で確かめる

### Decision: 録音の口は 127.0.0.1 に結び、`tailscale serve` で外へ出す
- **Context**: 要件 1.6〜1.8（閲覧とは別の口と認証）、マイクは安全な接続が要る
- **Selected Approach**: `LIVE_MINDMAP_REC_HOST` の既定を `127.0.0.1` にする。認証は、サーバーが作る長い鍵と Cookie（閲覧の `?pin=` の作りを写す）
- **Rationale**: LAN に開かない。TLS の終端を外に任せられ、コードに Tailscale の処理を入れずに済む
- **Trade-offs**: サーバーと同じ機器で `tailscale serve` を動かす運用が前提
- **Follow-up**: 中継越しの `Origin`/`Host`/`X-Forwarded-Proto` の扱いを実機で確かめる

### Decision: 同時 1 セッションは、共有の `SessionSlot` で守る
- **Selected Approach**: `Sessions` と `Recordings` が、同じ `SessionSlot`（`idle | pc | recording`）を取り合う。`Sessions` の `State` は変えない
- **Rationale**: `Live` を広げる案より影響が小さい。要件 3 の 2 方向（録音→PC、PC→録音）を 1 つの部品で満たす

### Decision: 文字起こしは、切り出した C# の実行ファイル `mindmap-stt` を子プロセスで呼ぶ
- **Selected Approach**: `stt/mindmap-stt.csproj`（net10.0）が、ヘルパーの `Transcription/*`・`Events.cs`・`SttFile.cs` をリンクで取り込む。ヘルパー側は、`Resampler` と `ModelDirectory` を別ファイルに移すだけにする（挙動は変えない）
- **Rationale**: 調整済みの STT の流用。ヘルパーの csproj を変えず、リンクで 2 つの実行ファイルが同じ源から作られる
- **Trade-offs**: 同じ源が 2 回コンパイルされる。ヘルパー（PC の会議）の挙動への影響は、ファイルの移動だけに抑える

### Decision: 途切れの記録は log に `intake-gap` を足し、エクスポートの `gaps` に出す
- **Selected Approach**: `IntakeLogEvent` に `intake-gap`（開始・終了の秒）を足す。`intake-` の接頭辞なので、復元は読み飛ばす。`JsonExport` に任意の `gaps` を足し、map.md には「取り込みの途切れ」の節を出す。map.html・map.drawnix は範囲外（要件）

### Decision: 受け口は PCM のバイナリ本文を直接受け、ポーリングで進み具合を返す
- **Selected Approach**: `PUT` の本文は `application/octet-stream`。進み具合は `GET` のポーリング（2 秒）で、`Viewers` の WebSocket には載せない
- **Rationale**: 利用者は 1 人で、閲覧用のフレームの種類を増やさずに済む

### 汎化・簡素化（design-synthesis）
- 汎化: 録音の口の「長い鍵 + Cookie + Origin の検査」は、閲覧の口と同じ作り。共通の部品に出すほどの数ではない（2 つ）ので、まず写す
- 簡素化: PWA の service worker・manifest・Background Sync は作らない（要件に無い。実機の検証の結果で必要になれば足す）。ライブ型・複数の利用者・音声の保持期間・スマホからの削除は作らない

## Risks & Mitigations
- 画面オフで録れない（要件 1.4）— Task 1 の実機の検証。だめなら同じ契約のネイティブのラッパー。結果次第で要件 1.4 の文面を改める
- 組み立ての時間が長い（`playback` は発言ごとに差分更新の完了を待つ）— Task で 1 時間の会議で実測し、遅ければ発言をまとめて流す工夫を設計に戻す
- `Track` の union に `部屋` を足すと 13 ファイルが触れる — コンパイラの網羅性の検査とテストで拾う。話者・出した人は持たない扱いを固定する
- 本文の大きさの上限が effect の HTTP サーバーにあるか未確認 — 断片は 320 KB 程度。実装で確かめる
- 中継越しの Cookie の `Secure` 属性 — `X-Forwarded-Proto` を見る。実機で確かめる
- sherpa-onnx 1.13.8 のネイティブ版が、使う Linux の glibc で動くか — サーバーで `mindmap-stt check` と短い wav の実行を確かめる

## References
- [ADR 0007](../../../docs/adr/0007-phone-recording-as-second-input.md) — 方針
- [ADR 0008](../../../docs/adr/0008-keep-phone-recording-audio.md) — 音声の保存
- [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve) — HTTPS の中継
- [sherpa-onnx NuGet 1.13.8](https://www.nuget.org/packages/org.k2fsa.sherpa.onnx/1.13.8) — Linux のランタイム
