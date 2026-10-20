# Project Structure

## Organization Philosophy

パッケージをプロセスで分ける（server・web・helper）。各パッケージの中は **純粋な中核と、外の世界とつなぐ外側** の 2 層。中核は依存を Effect の Service / Layer（C# ではインターフェース）で受け、外側が本物を差し込む。ディレクトリは浅く、機能ごとに 1 ファイル。

pnpm ワークスペースは server と web だけ。helper（.NET）と scripts は外にある。

## Directory Patterns

### server の中核
**Location**: `server/src/core/`
**Purpose**: ドメインの純粋なモジュール（マップ・セッション・発言・差分更新）。Node・HTTP・CLI に依存しない（`node:*` の import は型検査で弾かれる）
**Example**: `core/session.ts` は差分更新とログの書き先を Service で受ける。外へは `core/index.ts` の barrel でまとめて出す

### server の外側と入口
**Location**: `server/src/`（直下）
**Purpose**: HTTP・ブラウザ WebSocket・helper の起動と接続・Claude 呼び出し・閲覧の配信。入口は `server.ts` と `cli.ts` の 2 つだけ
**Example**: `sessions.ts`（セッションの状態、HTTP を知らない）と `http.ts`（経路と失敗→ステータスの表）を分ける

### CLI と server の共有プロトコル
**Location**: `server/src/serverProtocol.ts`
**Purpose**: 経路の記述 `{ method, path, body?, response }` と本文の Schema。import してよいのは `effect` の Schema だけ（web の型検査を Node に依存させない）。ドメインの値の Schema は core に置く

### web の純粋な関数と画面部品
**Location**: `web/src/`（直下）と `web/src/app/<feature>/`
**Purpose**: 直下はレイアウト・カメラ・畳みなどの純粋な関数。`app/<feature>/` は Foldkit のコードで、役割ごとにファイルを分ける
**Example**: `app/review/` に `main.ts`（Model / update / view）・`message.ts`・`command.ts`・`subscription.ts`・`mount.ts`・`entry.ts`

### テスト
**Location**: `server/test/`、`web/test/`（フラット）、`*/test/fixtures/`
**Purpose**: 名前は「対象モジュール + 観点」。偽物の Layer・データ・偽 helper は fixtures に置く
**Example**: `sessionPartial.test.ts`、`fixtures/sessionLayers.ts`

### helper
**Location**: `helper/`（直下は入口と配線）、関心ごとのサブフォルダ
**Purpose**: サブフォルダは名前空間と一致させる。差し替えたい境界はインターフェースにする
**Example**: `Transcription/ITranscriber.cs` を `SherpaTranscriber.cs` と `FakeTranscriber.cs` が実装する。`Audio/` は取得とエコーキャンセル

### Windows 用スクリプト
**Location**: `scripts/win-<対象や動詞>.cmd` + `.ps1`
**Purpose**: `.cmd` は WSL interop から呼ぶための薄いラッパー（引数をそのまま `.ps1` に渡す）、本体は `.ps1`。`.ps1` の先頭に用途と引数の例を日本語で書く。1 行で済むものは `.cmd` だけ

### 決定の記録
**Location**: `docs/adr/NNNN-kebab-title.md`、上流は `docs/adr/upstream/`
**Purpose**: この repo の判断は連番の ADR に、上流の判断は写しを残して参照先を保つ。語彙は `CONTEXT.md`

## Naming Conventions

- **TS のファイル**: lowerCamelCase（`helperSocket.ts`、`remarkSettling.ts`）。検査スクリプトと偽 helper だけ kebab-case（`check-test-layers.ts`、`fake-helper.ts`）
- **テストの層**: 接尾辞で決まる（`.test.ts` / `.it.test.ts` / `.heavy.test.ts`）。web では unit の中に `.story.test.ts`（update を流す）・`.scene.test.ts`・`.dom.test.ts` がある
- **型・Schema・Service**: PascalCase（`Snapshot`、`SessionLog`）。定数は UPPER_SNAKE（`DIFF_UPDATE_RETRY_MS`）
- **Foldkit の Message**: 動詞で始まる過去形の事実。Command の結果は `Completed<Command名>` か `Succeeded…` / `Failed…`
- **C#**: ファイル名は PascalCase で 1 ファイル 1 主型、file-scoped namespace（`Mindmap.Helper.<Sub>`）、インターフェースは `I` 接頭辞、具象は原則 `sealed class`、wire や DTO は `sealed record`
- **コメント・文書**: 日本語。ファイル先頭にモジュールの責務と関係する ADR を書く

## Import Organization

```typescript
// 相対パス + .ts 拡張子（path alias も @live-mindmap/* での import も使わない）
import { applyOps, emptyMap, type MeetingMap } from "./map.ts";
// web が server から取ってよいのは core の barrel（値）と serverProtocol（型だけ）
import { DiffUpdateState, SelfPaused } from "../../../../server/src/core/index.ts";
import type { SpeakerNameBody } from "../../../../server/src/serverProtocol.ts";
```

- 型だけのものは `import type` か `type X` のインライン
- テストは `../src/core/index.ts`（barrel）と `./fixtures/*.ts` から読む

## Code Organization Principles

- **依存の向き**: 外側 → core。core から外側（sessions・http・cli）への import は無い
- **web → server** は core の barrel と serverProtocol の型だけ。それ以外の server のモジュールを `web/src` から読まない（`web/test` は送り手と受け手を通しで確かめるために server の外側を読むことがある。例: `captions.test.ts`）
- **Effect の実行**は入口（`server.ts`・`cli.ts`）だけ。途中で `runPromise` しない（検査スクリプトで強制）
- **helper ↔ server の境界**は WebSocket のイベントの形。ここを変えるときは上流との互換を壊すので ADR を書く
- **上流との差**は「消す・差し替える」で作り、上流の構造は崩さない（上流の ADR と番号での参照が生きるように）

---
_Document patterns, not file trees. New files following patterns shouldn't require updates_
