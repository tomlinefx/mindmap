# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

## Spec-Driven Development

@CC-SDD-CLAUDE.md

---

## Project: mindmap（live-mindmap の Windows + Android 版）

- 語彙は `CONTEXT.md`、決定は `docs/adr/`。元プロジェクトは `/home/tomline/projects/live-mindmap-main`（MIT）。上流の ADR は `docs/adr/upstream/` に写す
- 構成: `server/`（Node、上流からコピー）、`web/`（表示、上流からコピー）、`helper/`（C# / .NET 10、新規）
- **置き場所と検証**: リポは Windows 側 `C:\Users\takah\projects\mindmap`。Claude Code は WSL から `/mnt/c/Users/takah/projects/mindmap` を編集する。実行・検証は WSL interop で Windows バイナリを叩く: `dotnet.exe build`、`pnpm.cmd test`、`node.exe server/src/server.ts`
- `/mnt/c` 越しの git は遅いので `git.exe -C 'C:\Users\takah\projects\mindmap' ...` を使う
- vite の dev server やテストの watch は WSL 側のファイル監視が効かないので、必ず Windows 側で起動する
- pnpm は `node-linker=hoisted`（`.npmrc`）。NTFS のシンボリックリンクを避ける
- interop で起動したプロセスの停止が不安定なことがあるので、起動・停止は `scripts/win-*.cmd` に閉じて 1 コマンドで行う
- 環境: Tailscale が常時稼働。閲覧の口を LAN 向けに開けば tailnet 越し（Android）にも同じ bind で届く。Tailscale 固有の対応はコードに入れない（ADR 0003）
- 閲覧の共有（ADR 0003）: セッション中に `cli share` で閲覧の口（既定 4320、`LIVE_MINDMAP_VIEW_PORT`）を全インターフェースに開き、LAN のアドレスごとの URL（`?pin=` 付き）を出す。Android はその URL をブラウザで開く。`cli share --stop` かセッションの終了で閉じる。初回は Windows Firewall の受信の許可が要る
- 検証コマンド（WSL から）: `cmd.exe /c 'C:\Users\takah\projects\mindmap\scripts\win-pnpm.cmd typecheck'`（tsc・effect-tsgo・fallow まで）、同 `-r test`（unit）、同 `-r test:it`（軽い IT）、同 `--filter @live-mindmap/server test`。`scripts/win-tsc.cmd` は server の tsc だけ
- heavy IT（Chromium・本物の子プロセス）は Windows で通る（2026-10-18）。web の heavy IT は `LIVE_MINDMAP_CHROMIUM` に Chromium の実行ファイル（Chrome の `chrome.exe` でよい）を渡す: `$env:LIVE_MINDMAP_CHROMIUM = "C:\Program Files\Google\Chrome\Application\chrome.exe"` のうえで `win-pnpm.cmd --filter @live-mindmap/web test:it:heavy`。server は `--filter @live-mindmap/server test:it:heavy`。シグナルの振る舞いそのものを見る 3 件は Windows では skip（ADR 0004）。web の画面照合は他のテストと並走すると稀にピクセル差の許容を超える（単独では通る）
- 開発サーバー: `scripts/win-dev.cmd [-Server|-Web]` で Windows 側に切り離して起動（PID・ログは `.dev/`）、`scripts/win-dev-stop.cmd` で止める。WSL から呼ぶと interop が子プロセスの標準出力を待って戻らないので、`run_in_background` で呼ぶ
- ビルド済み helper の配布物: `scripts/win-release-helper.cmd` が `helper/.release/mindmap-helper-win-x64-v<版>.zip` を作る（self-contained、第三者の表示込み。ADR 0006）。版は `helper/mindmap-helper.csproj` の `<Version>`。Releases へは WSL の `gh release create v<版> <zip>`。server は `%LOCALAPPDATA%\mindmap\helper` に展開したものも見る（`server/src/helperPath.ts`）
- 会議の開始・終了は 1 コマンド: `scripts/win-meeting-start.cmd [app id] [会議名]`（サーバーの起動・会議アプリの選択・`start`・`share`・ブラウザまで）と `scripts/win-meeting-stop.cmd [-StopServer]`（`stop` と書き出し先の表示）。Claude Code からは `/mindmap-start`・`/mindmap-stop`
