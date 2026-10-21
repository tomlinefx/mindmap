# Gap Analysis: speaker-attribution

_2026-10-20、`/kiro-validate-gap`。要件は未承認の時点の分析（要件の見直しにも使う）_

## 1. 現状

- **上流の話者分離の受け手は server・web に丸ごと残っている**。外れているのは Windows の helper だけ（helper は話者のイベントを 1 つも出さない）
  - `server/src/core/speakers.ts`: 話者の替わり目で発言を分ける・ラベル（相手 A…）を初出順に振る・確定ラベルを最大 3 秒待つ（`SPEAKER_WAIT_MS`）・起動し直しの重心でのつなぎ直し・仮ラベル
  - `server/src/core/speakerNames.ts`: 名前の表（推定 / 手入力、手入力優先、推定の付け替えは名乗りだけ）
  - `server/src/core/people.ts`・`personLine.ts`: 案の出した人・TODO の担当者
  - `POST /session/speaker-name`（会議中だけ）、字幕の名前の欄（`web/src/app/sessionLayout/speakerName.ts`）
  - 書き出し: `export.ts`・`markdown.ts`・`drawnix.ts`、見返し: `web/src/app/review/`
- **今の副作用**: 相手の発言は話者の確定を待って毎回約 3 秒遅れて差分更新に入る（`speakers.ts:9, 317-319`）。`map-update-latency` に直接効く
- helper → server の話者のイベントの形（`server/src/core/live.ts:42-64`、新しい helper が出すべきもの）:
  ```ts
  { type: "speaker", track, start, end, slot: Int>=0, final: Boolean }   // final:false は仮（字幕用）
  { type: "speaker-off", start, reason: "モデルなし" | "読み込みに失敗" | "途中で停止" }
  { type: "speaker-settled", track, to }        // to より前の確定区間はすべて届いた
  { type: "speaker-mixed", track, slot, start } // 枠に別の声が混ざった（5 人目以降）
  { type: "speaker-centroid", track, slot, centroid: number[] } // 起動し直し後のつなぎ直し用
  ```
  順序の約束: 更新ごとに「確定区間 → 仮の区間 → speaker-settled」（`speakers.ts:236-237`）

## 2. 要件と既存資産の対応

凡例: **Exists**（helper が話者を出せば動く）/ **Partial** / **Missing** / **Constraint**

| 基準 | 判定 | 根拠・要るもの |
|---|---|---|
| 1.1 初出順に A〜D | Exists | `speakers.ts:256-264` |
| 1.2 同じ人は同じラベル | Exists | `slotLabels`、起動し直しは `speaker-centroid`（新 helper も重心を出す必要） |
| 1.3 途中の交代で分ける | Exists | `splitBySpeaker`（`:158-173`）。wordTimes が要る |
| 1.4 5 人目以降は「相手」 | Partial / Constraint | server に上限なし（E, F… と振る）。helper の枠 4 + `speaker-mixed` 頼み。mixed で元の 4 人の 1 人もラベル無しになる（`:356-363`）→ 要件と食い違う |
| 1.5 待ち切れなければ「相手」 | Constraint | 振る舞いはあるが 3 秒待つ。上限は latency 側で決める |
| 1.6 自分は「自分」 | Exists | `speakers.ts:335` |
| 1.7 `check` で知らせ、分けずに始める | Partial | 会議中の `speaker-off` はある。`check` に任意の部品の口が無い（`Check.cs:40`、`startupCheck.ts:9,51`） |
| 2.1 画面で名前 | Partial | 相手 A〜D は動く。「自分」に付けられない（`sessionSinks.ts:167`、`captions.ts:173`） |
| 2.2 CLI で名前 | Missing | HTTP の口はあるが CLI コマンドが無い |
| 2.3 置き換え・過去にも反映 | Exists | `speakerNames.ts:54-62`、表示は毎回表から |
| 2.4 いない話者は拒む・伝える | Partial | server は 400。web は結果を無視、CLI なし |
| 2.5 名前が無ければラベル | Exists | `personLine.ts:12-14` |
| 3.1〜3.4 名乗りから推定 | Exists | `claudePrompt.ts:111-115`、`speakerNames.ts:58-71` |
| 3.5 推定と手入力を見分けて表示 | Missing | 出どころは表にあるが、画面へのフレームで落ちる（`speakerNames.ts:15-18`） |
| 4.1 終了後に名前を付ける | Missing | 会議中だけ（終了後 409、`sessions.ts:491-503`） |
| 4.2 直した名前で 4 形式を作り直す | Missing | `cli review` は map.html だけ。`cli export` は export.json を出すだけで名前を含まない |
| 4.3 見返しに最新の名前 | Partial | 字幕は名前を使う。マップは `speakerNames: {}` 固定（`review/main.ts:113`） |
| 4.4 restore で名前も戻る | Partial | ラベルは戻る。`speaker-name` の行は読み飛ばし（`session.ts:290`、`intake.ts:19`） |
| 5.1〜5.3 決定を口にした人 | Missing | 決定に人の欄なし。案の `proposer`・`mergedProposer`（`map.ts:294-312`）を流用できる |
| 5.4 ラベル無しは「相手」と出す | Missing / Constraint | `speakerName("相手")` は null で出さない（`personLine.ts:13`）。要件と逆 |
| 6.1 決定のノードに人 | Missing | `personLine` は案と TODO だけ |
| 6.2 案・TODO に名前 | Exists | `mapSurface/main.ts:492` |
| 6.3 根拠の発言に話者 | Missing | `sidePanel/main.ts:29` はトラックだけ |
| 6.4〜6.6 字幕・仮表示・色 | Exists | `captions.ts:137-183`。マップのノードに話者の色は無い |
| 6.7 他の端末にも | Exists | `viewers.ts` が名前のフレームを保持・配信 |
| 7.1 map.md の決定に人 | Missing | `markdown.ts:54-56` |
| 7.2 map.md の根拠に話者 | Missing | `stamp` は時刻だけ（`markdown.ts:9-13`） |
| 7.3 map.json | Partial | 発言のラベルは入る。対応表は名前のあるものだけ |
| 7.4 drawnix・html | Partial | drawnix は案・TODO だけ。html のマップに名前なし |
| 7.5 名前が無ければラベル | Partial | ラベル無しの「相手」が消える（5.4 と同じ原因） |

集計: Exists 17 / Partial 10 / Missing 11 / Constraint 2（重複あり）

**ついでに見つけた不具合寄りの点**: `export.json`（`session.ts:705`）は名前を含まないので、`cli export` は会議中でも名前が抜ける。名前が入るのは終了時の map.json だけ。

## 3. helper の話者分離（外部調査）

sherpa-onnx 1.13.8（今の依存）の C# に `SpeakerEmbeddingExtractor`・`SpeakerEmbeddingManager`・`OfflineSpeakerDiarization` がある（NuGet の DLL で確認）。Sortformer は無い。

| 案 | 依存 | 遅延（区間の終わりから） | 精度 | 所見 |
|---|---|---|---|---|
| **E1: 区間ごとの埋め込み + 逐次クラスタリング**（sherpa の Extractor、CAM++ 28MB） | 増えない | ~0.1 秒の見込み（要実測） | Sortformer より劣る想定。重なり不可、閾値の調整が要る | クラスタリングと窓ずらしの交代検出は C# で自前（数百行） |
| E2: Streaming Sortformer 4spk v2 の ONNX（上流と同系統） | OnnxRuntime 直呼び、~470MB | 0.32〜1.04 秒（モデルカード） | 上流並み | mel 特徴と状態キャッシュの移植。sherpa 同梱の onnxruntime と共存できるか未確認。CC-BY-4.0 |
| E3: Nemotron-3-Diarization（Sortformer 後継、8 話者） | Rust 実装（parakeet-rs）を FFI か移植、~400MB | 0.32〜1.04 秒 | 多言語学習（日本語は未明記） | CPU の実時間性未確認、OpenMDW-1.1 |
| E4: pyannote seg-3.0 + `OfflineSpeakerDiarization` を窓ごとに | 増えない | 窓が長いほど伸びる | 窓の間で番号が揃わない | 逐次には不向き。会議後の作り直し向け |

どれでも §1 のイベントの形は使える。helper の中で実装を差し替えられるよう、イベントの形を固定するのが妥当。

## 4. 実装の選択肢

### Option A: 既存を広げる
- helper に話者分離（E1 か E2）を足し、§1 のイベントを出す。server・web の受け手は既存のまま
- 決定の人は案の `proposer` の仕組みを決定に広げる（`people.ts`・`map.ts`・`personLine.ts`）
- 根拠の発言・map.md の根拠に話者を足す（`sidePanel`・`markdown.ts`）
- 「自分」に名前、CLI の名前コマンド、終了後の名前と作り直しは、既存の `speakerNames`・`cli review` を広げる
- ✅ 上流の契約・テスト（`speakers.test.ts` 105 件ほか）がそのまま効く ❌ `speakers.ts` の 3 秒待ちと 5 人目の扱いが要件と食い違うので、上流のコードに手を入れることになる

### Option B: 新しく作る
- 話者の決定を helper で完結させ（ラベルまで helper が振る）、server の `speakers.ts` を単純な受け手に置き換える
- 会議後の名前と書き出しを独立したコマンド（例: セッションのフォルダを対象にした名前付けと作り直し）にする
- ✅ 待ち・上限の規則を Windows 版の都合で決め直せる ❌ 上流との差が大きくなる。既存テストの多くを作り直し

### Option C: ハイブリッド（段階的）
- 第 1 段: helper に E1（依存が増えない）を足して既存の受け手に流す。決定の人・根拠の話者・書き出し・「自分」の名前・CLI を Option A で足す
- 第 2 段: 会議後の名前と 4 形式の作り直し（log.jsonl に `speaker-name` を足し、そこから作り直す）
- 第 3 段（必要なら）: 精度が足りなければ helper の中だけ E2 に差し替える
- 待ち時間の上限と 5 人目の扱いは `speakers.ts` に小さく手を入れる（latency 側と合わせて決める）
- ✅ 早く動くものが出る、差し替えの範囲が helper の中に閉じる ❌ 段の間で要件の一部（4.x）が後回しになる

## 5. 規模とリスク

- **規模: L（1〜2 週間）**。helper の話者分離が新規（数百行 + 閾値の調整）、server・web・書き出しの欠けは既存の仕組みの延長で数か所ずつ
- **リスク: High**。日本語の会議音声（コーデックで劣化）での話者分離の精度が未知。閾値で「1 人が割れる / 2 人が混ざる」のどちらにも転ぶ。それ以外（名前・決定の人・書き出し）は Low

## 6. 設計フェーズへの申し送り

**決めること**
- 話者分離の方式（E1 から始めて E2 に差し替えられる形にするか）
- 3 秒待ちの上限（`map-update-latency` と合わせて）と、待っている間マップへ送るのを止めるか、「相手」で送って後から直すか
- 5 人目以降の扱いを server で強制するか（要件 1.4 は「5 人目以降だけ相手」、上流は mixed で枠ごとラベルを外す）
- 決定を口にした人の欄を、案の `proposer` と共通の形にするか
- `check` の「任意の部品」をどう表すか（新しい状態か、印か）
- 終了後の名前の保存先（log.jsonl に行を足すか、別ファイルか）と、作り直すコマンドの形
- 要件 3.5（推定と手入力の見分け）を残すか。残すならフレームの形が変わる

**試作で確かめること（Research Needed）**
1. 埋め込み 1 回の CPU 時間（CAM++ / ERes2NetV2 / titanet_small、区間 1・3・5 秒、STT と同時）
2. 日本語の会議音声（Meet・Teams・Zoom のループバック）でのモデル比較と閾値の決め方（同じ人どうし・別の人どうしの類似度の分布）
3. 合成会議の台本での発言ごとの話者の正答率、割れる・混ざる率
4. 新しい話者を作る最小長、重心の更新の重み、短い区間（相づち）を寄せる規則
5. 窓をずらした交代検出の検出率と時刻の誤差
6. 声の近い 2 人、コーデックの劣化、5 人以上での振る舞い
7. （E2 にするなら）Sortformer の ONNX の CPU 実時間係数と、sherpa 同梱の onnxruntime との共存
8. 話者埋め込みモデルのライセンス（3D-Speaker のモデル単体の表記、titanet のモデルカード）と ADR 0005 の第三者表示

**参考**
- sherpa-onnx の C# 例: https://github.com/k2-fsa/sherpa-onnx/tree/master/dotnet-examples
- 話者埋め込みモデル: https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models
- diart（逐次クラスタリングの方式の参考）: https://github.com/juanmc2005/diart
- Streaming Sortformer v2: https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2
- 上流 ADR 0013: `docs/adr/upstream/0013-diarize-in-helper-split-remarks-by-speaker.md`
