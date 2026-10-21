# Research: map-update-latency

_2026-10-20、要件を起こすための調査。設計で使う_

## 実測（2026-10-20 の会議 1 回、約 4 分、発言 28・差分更新 16、claude-sonnet-5-5）

音声の時刻は helper の原点からの秒で、原点はログに残らない。セッションのフォルダ名の時刻を原点とみなした（誤差 ±0.3 秒程度）。集計スクリプトは使い捨て（本文は扱わない）。

| 区間 | n | 最小 | 中央値 | p90 | 最大 |
|---|---|---|---|---|---|
| 自分: 音声の終わり → remark がログに載る | 19 | 1.06 | 1.19 | 7.38 | 8.26 |
| 相手: 音声の終わり → remark がログに載る | 9 | 4.01 | 7.18 | 34.96 | 43.03 |
| remark → 差分更新の呼び出し開始 | 16 | 0.00 | 0.00 | 2.23 | 2.44 |
| 差分更新の呼び出し | 16 | 2.14 | 2.75 | 3.66 | 3.93 |
| **音声の終わり → 差分操作の反映** | 16 | 3.33 | **約 4.4** | **11.0** | 11.19 |

反映から配信までは数 ms。web の移動アニメ 0.5 秒が加わって体感約 5 秒。

## 段ごとの遅れ

| 段 | 遅れ | 根拠 | 調整のしやすさ |
|---|---|---|---|
| マイクの取り込みバッファ | 約 0.1 秒（推定） | `helper/Audio/Capture.cs:37` | 中 |
| エコーキャンセル（自分だけ） | 0.15 秒 | `helper/Audio/EchoCancellation.cs:16` | 低 |
| VAD が区間を閉じるまで | 0.6 秒 | `helper/Transcription/SherpaTranscriber.cs:62` `MinSilenceDuration` | 高（短くすると発言が細切れ） |
| 確定時のデコード | 0.1〜0.3 秒（推定） | 同 `:160, :171` | 中 |
| 長い区間の再デコードの詰まり | 平常 0、詰まると +5〜7 秒（推定） | 同 `:141-143`（0.5 秒ごとに頭から）、`:23`（最大 12 秒）、`:29`（上限なしの待ち行列）、`:47` | 中 |
| **相手の話者待ち** | **3 秒以上、上限なし（実測 4〜43 秒）** | `server/src/core/speakers.ts:9` `SPEAKER_WAIT_MS=3000`、`:317, :338`。helper が speaker 系イベントを出さず `speaker-off` も来ないので常に待つ。時計は届いた結果の end でしか進まない | 高 |
| 差分更新を始めるまで | 0 | `server/src/core/session.ts:476-486` | — |
| 差分更新は 1 本ずつ | 0〜2.4 秒 | `session.ts:481, :505-516`（たまった分は次の 1 回に） | 中 |
| **差分更新の呼び出し** | **中央値 2.75 秒** | `modelSelection.ts:5`（sonnet）、`claude.ts:39-42`（effort medium）、`:101-110`（構造化出力・maxTurns 4）、`:164-207`（結果がそろうまで待つ） | 中（質を落とさない範囲で） |
| query の開き直し | 14 回ごとに +1 秒程度 | `claude.ts:28` `QUERY_RENEW_CALLS = 14` | 中 |
| web の移動アニメ | 0.5 秒 | `web/src/app/mapSurface/main.ts:105` | 高 |

## 効いている順
1. 差分更新の呼び出し 2.75 秒（平常時の約 6 割）→ ノードを 1 秒で出すことは目標にしない（主催者と合意）
2. 相手の話者待ち 3 秒以上・上限なし（外した話者分離の名残）→ 最も安く大きく削れる
3. helper の区間の閉じ方とデコード 約 1.1 秒
4. helper の詰まり p90 で +5〜7 秒
5. 1 本ずつの呼び出し 0〜2.4 秒、アニメ 0.5 秒

## 設計で調べること
- 構造化出力で API の往復が 2 回になっていないか（出力 100〜250 トークンで 2.7 秒）
- 操作を途中で流す（ストリーミング）と、最初の操作が出るまでを縮められるか
- effort・プロンプトの大きさ（入力 9k→17k トークンと増える）と速さの関係を、質を保ったまま
- 取り込み待ちの表示に使えるもの（字幕・確定した発言のフレームはすでに配信している）
- 遅れの記録: 原点（origin）の壁時計と、表示の時刻をログに残す
- 流し直しの評価（`cli evaluate`・`play`）で質の比較ができるか

---

# 設計の調査と判断（`/kiro-spec-design`、2026-10-20）

## Summary
- **Feature**: `map-update-latency`
- **Discovery Scope**: Extension（既存のパイプラインの調整と、表示用のフレーム 1 つの追加）。性能が要の機能なので、light discovery に外部 API（Agent SDK）の確認を足した
- **Key Findings**:
  - 相手の話者待ちは、helper が `speaker-off` を出せば今ある経路で消える（テストが同じことをしている `http.it.test.ts:106`）。壁時計の上限は Effect の Clock + `Effect.sleep` の Fiber で張れる（前例 `speakingRelay.ts:51-61`）
  - 取り込み待ちに当たるデータ（話者待ち・pending・reflecting）は server にすでにあり、字幕の盤が使っている。発言の ID と状態を持つフレームが無いだけ
  - 差分更新は失敗するとその回の発言を処理済みにして捨てる（`session.ts:623-626`）。呼び出しにタイムアウトが無い。要件 3.3 とぶつかる
  - Agent SDK 0.3.288 の `query()` は `thinking`（adaptive / enabled / disabled）・`effort`・`includePartialMessages` を受ける。Sonnet 5.5 は `{type:"disabled"}` を API が 400 で拒み、思考を切るには `between_tools` が要るが、SDK の型に `between_tools` は無い

## Research Log

### Agent SDK の思考と effort
- **Sources**: `server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（`ThinkingConfig` 9690-9706、`thinking?` 1906、`effort?` 1913、`includePartialMessages?` 1862）、claude-api スキルの Thinking & Effort 表
- **Findings**: Sonnet 5.5 は既定で adaptive thinking が動く（effort の既定 high、今のコードは medium）。`disabled` は 400。Haiku 5.5 は effort 既定 medium、`disabled` は high 以下で可
- **Implications**: 思考を切る・effort を下げるのは、モデルを替えずに呼び出しを縮める候補。SDK が Sonnet 5.5 で `disabled` をどう扱うか（between_tools に読み替えるか、400 になるか）は未確認 → 小さな実呼び出しで確かめてから候補にする（CODING_STANDARDS の「SDK の未確認の振る舞い」）

### 構造化出力と途中適用
- **Findings**: 結果は `result` メッセージの `structured_output` で一度に届く（`claude.ts:164-187`）。`includePartialMessages` で途中の JSON を読めば操作を早く当てられるが、操作の途中適用は「1 回の操作列をまとめて当てる」前提（統合・移動の参照）を崩す
- **Implications**: 途中適用はこの仕様では採らない（Non-Goal）。数字が足りなければ次の段で検討

### 計測に使える時刻
- **Findings**: helper の origin は QPC の刻みで壁時計ではない（`helper/RunSession.cs:18,28`）。server はログに残さない。remark 行の `at` は話者待ちの後
- **Implications**: origin に壁時計（Unix ms）を足し、server がログに 1 行残す。remark 行に「締まった時刻」と「取り込み待ちに出した時刻」を足す

## Design Decisions

### Decision: 話者待ちを消す方法
- **Alternatives**: 1) server で `off` を初めから true にする 2) helper が起動直後に `speaker-off`（理由「モデルなし」）を出す 3) 待ちの上限だけ入れる
- **Selected**: 2 + 3。helper は話者分離を持たないことを自分で表明する（上流の契約どおり）。加えて、話者分離が入った後も効く壁時計 2 秒の上限を server に張る
- **Rationale**: 1 は speaker-attribution で話者分離を足したときに外し忘れる。2 は契約の意味どおりで、話者分離が入れば helper 側で出さなくなるだけ
- **Trade-offs**: helper と server の両方に手が入る

### Decision: 取り込み待ちの表示の置き場所
- **Alternatives**: 1) 字幕の吹き出しを流用 2) 新しいフレーム `pending-remarks` と、マップの上の表示
- **Selected**: 2。中身の組み立ては core の純粋関数、配信は viewers の保持付きフレーム
- **Rationale**: 要件 1.1 は「マップの上」。字幕は途中結果用で 300ms 間引きがあり、発言の ID を持たない
- **Trade-offs**: 未反映の発言が字幕とマップの上の両方に出る。字幕側は変えない（Out of Boundary）

### Decision: 呼び出しを縮める手段（Generalization）
- 思考・effort・モデルは「差分更新の調整（UpdaterTuning）」1 つの値にまとめ、流し直しの評価で比べられる形にする。既定は評価が同等以上のときだけ替える（要件 4）
- VAD の無音の長さも同じ扱い（helper の引数、既定は評価の後）

### Decision: Build vs Adopt
- 計測の集計は自前（`core/latency.ts`）。既存の `logMetrics.ts` と同じく log.jsonl を当て直す純粋関数。外部の計測基盤は入れない（ローカルの単一ユーザー）

### Simplification
- 途中適用（ストリーミング）・呼び出しの並列化・prompt の縮小は採らない。まずは待ちの除去・詰まりの解消・失敗時の取りこぼし防止・思考の調整で目標に届くかを測る

## Risks & Mitigations
- 思考を切ると統合・移動の判断が粗くなる → 流し直しの評価で決定・TODO の再現率と種別違いを比べ、下回れば既定にしない
- VAD を短くすると発言が細切れになり、マップが細かくなる → 同じく評価で比べる。録音した音声で比べる経路を先に確かめる
- 失敗した発言を戻し続けると、同じ発言で失敗が続く → 再試行の間隔を延ばし、取り込み待ちの表示で見えるようにする（落とさない）
- 評価に使う正解ファイル（`--truth`）が repo に無い → 録った会議 1 本に正解を作るのを最初のタスクにする

---

# 設計の見直し（`/kiro-validate-design`、2026-10-20）と直し（2026-10-21）

見直しの判定は NO-GO。主催者と次の 3 点を決め、design.md に入れた。

1. **失敗した発言を戻すと restore・同じ発言の失敗の繰り返しとぶつかる** → 主催者の判断「3 回で諦めて表示」。要件 3.5 を足した（再承認待ち）
   - diff 行に `requeued: true` を残し、restore の `consumeFresh` はその行の発言を反映済みにしない（`session.ts:253-255` の変更）。戻した発言は既存の規則（`session.ts:331`）で pending に戻る
   - 応答が返ってきたうえでの失敗が同じ発言で 3 回続いたら、その発言 1 つだけで呼ぶ（`isolated: true`）。それも失敗したら外し、表示で 5 秒知らせる。時間切れ・つながらない失敗は数えない（回線断で発言が外れないように。設計で足した判断）
2. **自分のトラックは締まるまで中央値 1.19 秒で、取り込み待ちの 1 秒に届かない** → 主催者の判断「区切りを先に知らせる」
   - helper が `Drain` で区間を取り出した直後、確定のデコードの前に `segment-end{track,start,end}` を出す。server は最後の途中結果の本文で仮の項目（closing）を出し、確定結果で置き換える。突き合わせは track と start（helper が揃えている）
   - 見込み: 自分 約 0.85 秒、相手 約 0.7 秒。VAD の 0.6 秒が残るので余裕は小さい
   - server は知らない type を読み飛ばす（`live.ts:73-89`）ので互換
3. **中央値 3 秒が、確かめていない思考の調整に頼っている** → 主催者の判断「先に試してから進む」
   - 実装の最初のタスクを ThinkingSpike（使い捨て）にし、その後に Checkpoint を置く

helper にはテストのプロジェクトが無い（`helper/mindmap-helper.csproj` だけ）。segment-end は `stt-file` のイベント列で手で確かめる。

---

## 試し: 思考の調整（タスク 1.1）

_2026-10-21。試しのコード（`server/scripts/thinkingSpike.ts`）は使い捨てで、消した。本文は扱っていない（出したのは数・種類・時間・エラーの種類だけ）_

### 条件
| 項目 | 値 |
|---|---|
| モデル | `claude-sonnet-5-5` |
| SDK | `@anthropic-ai/claude-agent-sdk` 0.3.288（Windows、Node v22.23.2） |
| 入力 | 2026-10-20 の会議（`2026-10-20T01-30-05.324Z`）の diff 行の 7〜16 番目（10 回分、ノード 1〜4）。1〜6 番目はノード 0 のマップで「前回からの変更」の経路を通らないので外した |
| 入力の作り方 | ログを diff 行の手前まで `restoreState` で戻した map・previousResponse と、diff 行の recent・fresh の ID の発言。共有画面・話者名は無い（ログに画面の行が無く、話者名はログに残らない） |
| 組み立て | `buildPrompt`・`SYSTEM`（+ `claudeTuning` の `systemAppend`）・`OUTPUT_SCHEMA` と、`server/src/claude.ts` と同じ options（tools 無し・maxTurns 4・構造化出力・env は process.env を引き継ぐ）。1 本の query に 10 入力を順に送る（1 通目は全体、2 通目から前回からの変更） |
| 今のコードとの違い | 思考の block を数えるため、全設定で `includePartialMessages: true` を足した |
| 回数・順 | 各設定 3 回 × 10 入力 = 30 回。回ごとに a → b → c の順 |
| 時間 | 送る直前から `result` を受けるまで。90 回すべて成功（失敗・利用上限なし） |
| 認証 | server と同じく process.env を子プロセスに渡した。この実行の環境には `ANTHROPIC_API_KEY` が無く、CLI がどの資格情報で通ったかは未確認 |

### (1) 思考を切れたか
**切れなかった。** 試した 4 つの形のうち 3 つは呼び出しが通ったが、どれも思考の block が残った。もう 1 つ（`between_tools`）は CLI が起動しなかった。

| 設定 | 思考の block があった呼び出し（/30） |
|---|---|
| (a) effort medium、thinking を渡さない（今の設定） | 6 |
| (b) effort medium + `thinking: {type:"disabled"}` | 7 |
| (b') effort medium + `maxThinkingTokens: 0` | 5 |
| (b'') effort medium + `settings: {alwaysThinkingEnabled: false}` | 8 |
| (c) effort low、thinking を渡さない | 4 |

- 判定は、assistant の content の `thinking`・`redacted_thinking` と、stream event の `content_block_start` の両方で数えた（どの呼び出しでも両者の数は一致した）
- 判定が効くことの対照: 入力 1 つを effort high で呼ぶと、思考の block が 1 つ出た（出力 357 トークン、4.8 秒）
- medium・low の adaptive でも、思考の block が出たのは一部の呼び出しだけ（(a) 6/30、(c) 4/30）

### (2) 渡し方
| 形 | 結果 |
|---|---|
| `thinking: {type:"disabled"}`（SDK が `--thinking disabled` に変える） | 400 にならず通る。思考の block は残る（7/30） |
| `extraArgs: {thinking: "between_tools"}` | CLI が起動時に拒む: `option '--thinking <mode>' argument 'between_tools' is invalid. Allowed choices are enabled, adaptive, disabled.` |
| `maxThinkingTokens: 0` | 通る。思考の block は残る（5/30） |
| `settings: {alwaysThinkingEnabled: false}` | 通る。思考の block は残る（8/30） |
| （参考）`thinking: {type:"enabled", budgetTokens: 4000}` | 入力 1 つで 1 回。通り、思考の block は 0 |

設計の調査（上の「Agent SDK の思考と effort」）にある「`disabled` は 400」は、SDK 経由では起きなかった。`between_tools` は、SDK からも `extraArgs` からも渡せない。

### (3) 各設定の時間の中央値（ms、成功した呼び出しのみ）
| 設定 | n | 中央値 | 最小 | 最大 | query の 1 通目を除いた中央値 | 出力トークンの中央値 |
|---|---|---|---|---|---|---|
| (a) 今の設定 | 30 | 2012 | 1634 | 3224 | 1891 | 110.5 |
| (b) `disabled` | 30 | 1892 | 1514 | 3799 | 1852 | 114 |
| (c) effort low | 30 | 1782 | 1509 | 3294 | 1690 | 85 |
| (b') `maxThinkingTokens: 0`（a〜c の後に別に実行） | 30 | 2008 | 1647 | 3346 | 1990 | 114 |
| (b'') `alwaysThinkingEnabled: false`（同上） | 30 | 1971 | 1520 | 3144 | 1898 | 100 |

(b') と (b'') は a → b → c の交互の順には入れておらず、別の時間帯に続けて測った。

### (4) 操作の数・種類の差（30 回の合計）
| 設定 | 合計 | noop | add | update | close |
|---|---|---|---|---|---|
| (a) 今の設定 | 31 | 15 | 14 | 0 | 2 |
| (b) `disabled` | 30 | 14 | 12 | 0 | 4 |
| (c) effort low | 30 | 15 | 12 | 0 | 3 |
| (b') `maxThinkingTokens: 0` | 30 | 17 | 12 | 0 | 1 |
| (b'') `alwaysThinkingEnabled: false` | 30 | 15 | 10 | 2 | 3 |

- 1 回の呼び出しの操作の数はほぼ 1 で、2 になったのは (a) の 1 回だけ（入力 3 番目）
- combine・move・delete は、どの設定でも出なかった
- 質（決定・TODO の再現率）は見ていない（タスク 8.2・8.4）

## 進め方の判断（タスク 1.2）

_2026-10-21、主催者の判断_

- 試しの結果: 思考は切れず、調整で縮むのは 0.1〜0.2 秒ほど。話し終え → 反映の中央値の見込みは 約 3〜3.5 秒（締まり 1.2 秒 + 呼び出し 1.8〜2.0 秒 + 前の呼び出しの待ち 0〜2.4 秒）
- **判断: そのまま 2 以降に進む。** 大きく効くのは相手の話者待ちと helper の詰まりの除去。思考・effort の調整は、効きが小さい評価の候補として 8 に残す。3 秒に届くかは 9.1 の実際の会議で測る
