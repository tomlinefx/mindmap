# Technology Stack

## Architecture

3 つのプロセスが一方向に流れる: **helper（C#）→ server（Node）→ web（ブラウザ）**。操作は CLI から server に HTTP で行う。

- **helper**: server がセッションごとに子プロセスとして起動する。空きポートを引数で受け、127.0.0.1 の WebSocket でイベント（`remark`・`partial`・`origin`・`self-pause` など）を流す。イベントの形は上流の Swift 版と同じに保つ。これが server と web を上流からほぼそのまま使える理由（ADR 0001）
- **server**: 常駐（既定 4319、`LIVE_MINDMAP_PORT`）。セッションの状態・差分更新（Claude Agent SDK）・ログ・書き出しを持つ。HTTP とブラウザ向け WebSocket は effect/http（上流 ADR 0009）。操作の口は 127.0.0.1、閲覧の口（既定 4320）は `share` 中だけ全インターフェースに開く（ADR 0003）
- **web**: 描画だけ。推論しない（上流 ADR 0012）。開発時は vite（5173）が `/ws` などを server に proxy する
- **CLI**: `node server/src/cli.ts`。本文と応答の Schema は server と 1 つのモジュール（`serverProtocol.ts`）で共有する（上流 ADR 0023）
- Windows にシグナルが無いので、server の停止は `POST /server/stop`（ADR 0004）

## Core Technologies

- **TypeScript（server / web）**: TypeScript 7（tsgo）。Node 22 の type stripping で `.ts` をビルドせずに直接実行する
- **C#（helper）**: .NET 10（`net10.0-windows`、win-x64）、`Nullable` 有効、警告はエラー
- **パッケージ管理**: pnpm ワークスペース（server・web）。`node-linker=hoisted`（NTFS のシンボリックリンクを避ける）

## Key Libraries

コードの書き方を決めるものだけ:

- **Effect 4**（server・web 共通）: 中核の依存は `effect` 本体だけ。外から来るデータは Schema で検証し、依存は Service / Layer で受け、並行処理は Effect で書く（上流 ADR 0007〜0010）
- **Foldkit**（web）: Effect ベースの Elm 風フレームワーク。React は使わない。Model / Message / update / view / Command / Subscription に分ける
- **Tailwind v4**（web）: Preflight と既定テーマを外し、色は token。クラスは BEM にユーティリティを並べる（`web/AGENTS.md`）
- **Claude Agent SDK**（server）: 差分更新に使う。通常の dependencies に置く（ADR 0002）。認証は利用者の `ANTHROPIC_API_KEY`
- **helper の音声と STT**: NAudio（WASAPI Process Loopback・マイク）、WebRTC AEC3（自前の C シム dll を P/Invoke）、sherpa-onnx（日本語 Zipformer + VAD。ストリーミングモデルが無いので VAD 区間を短い間隔で再デコードして途中結果を作る）

## Development Standards

### Type Safety
- server・web とも `strict` + `noUncheckedIndexedAccess`、`verbatimModuleSyntax`・`erasableSyntaxOnly`（type stripping で消せる構文だけ）
- `server/src/core` は `types: []` の別 tsconfig で型検査し、Node の型に触れないことを機械で保つ
- effect-tsgo の diagnostics を typecheck に含める（古い API は error）

### Effect の三分類（`CODING_STANDARDS.md`）
- 失敗も待ちも依存も無い → 素の関数
- 外から来る壊れ（helper のイベント・ディスク・モデルの出力・引数）→ `Effect<A, TaggedError>`（`Result` は使わない）
- 自分のコードとの約束違反 → defect（`throw` / `Effect.die`）

### Code Quality
- **fallow**: 未使用の export・依存、重複、複雑度（cyclomatic 20 / cognitive 15）。抑制には理由が要り、「誤検知」「後で直す」は理由にならない
- **独自の検査**（`server/scripts/check-*.ts`、typecheck の一部）: `runMain` は `server.ts`・`cli.ts` だけ、`runPromise` は禁止。unit テストが本物の資源を import していないこと
- **oxlint + Foldkit プラグイン**（`web/src/app` だけ）: Message は動詞で始まる過去形の事実、`NoOp` は使わない

### Testing
層はファイル名の接尾辞で決まる（vitest projects と検査スクリプトで強制）:

| 接尾辞 | 層 | 中身 |
|---|---|---|
| `*.test.ts` | unit | 偽物の Layer で組む。本物の fs・net・子プロセス・SDK は import しない |
| `*.it.test.ts` | 軽い IT | 本物のファイル・プロセス・ソケット。偽の helper（`fixtures/fake-helper.ts`）を使う |
| `*.heavy.test.ts` | 重い IT | Chromium（`LIVE_MINDMAP_CHROMIUM` で外から渡す）や本物の子プロセス |

- テストは内部構造でなく契約を確かめる。足すのは証拠がそろったときだけ（`CODING_STANDARDS.md` の証拠ゲート）
- 守っている行を消したら赤になることを確かめる
- POSIX シグナルそのものを見るテストは Windows では skip（ADR 0004）
- helper（C#）に自動テストは無い。`check` サブコマンドと実会議で確かめる

## Development Environment

### Required Tools
- Windows 10 2004 以降、Node 22、pnpm、.NET 10 SDK（helper をビルドするとき。普段は Releases のビルド済みを使う、ADR 0006）
- STT モデル（`win-stt-models`）、AEC の dll（`win-webrtc-apm`、VS の C++ が要る）

### Common Commands
```powershell
# 検証（tsc・effect-tsgo・独自検査・fallow まで）
scripts\win-pnpm.cmd typecheck
scripts\win-pnpm.cmd -r test          # unit
scripts\win-pnpm.cmd -r test:it       # 軽い IT
# 開発サーバー（切り離して起動、PID とログは .dev\）
scripts\win-dev.cmd [-Server|-Web] ; scripts\win-dev-stop.cmd
# helper
scripts\win-helper-build.cmd ; scripts\win-release-helper.cmd
# 会議
scripts\win-meeting-start.cmd [app id] [会議名] ; scripts\win-meeting-stop.cmd
```

起動・停止は必ず `scripts/win-*.cmd` に閉じる（interop から起動したプロセスの停止が不安定なため）。vite やテストの watch は Windows 側で動かす。

## Key Technical Decisions

- この repo の ADR は `docs/adr/`、上流の ADR は `docs/adr/upstream/`。コード中の「ADR 00xx」は原則として上流の番号
- 0001: helper は C#、server との境界は上流と同じ WebSocket イベント
- 0002: server / web は上流から履歴なしでコピーしてスリム化（fork にしない）
- 0003: 他の端末（ADR の題では Android。OS は問わない）は LAN でブラウザから見るだけ。Tailscale 固有の対応は入れない
- 0004: server の停止は HTTP で求める
- 0005 / 0006: MIT + 第三者の表示を同梱、ビルド済み helper は GitHub Releases

---
_Document standards and patterns, not every dependency_
