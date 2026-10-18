# server/web は live-mindmap から履歴なしでコピーしてスリム化し、Claude Agent SDK は通常の依存に戻す

server（差分更新エンジン・セッション状態・ログ・CLI）と web（表示）は OS に依存しない設計（上流 ADR 0003 / 0007）なので、live-mindmap（MIT）から git の履歴を持たずにコピーし、コア体験に要らないもの（publish・tunnel・recorded・apple*・chatgpt*・判定と振り分け・共有画面・話者分離・bench・e2e）を消す。fork にしないのは、Mac 前提のテストと機能が残り続けるのを避けるため。コード中の「ADR 00xx」は上流の番号で、上流の ADR は `docs/adr/upstream/` に写して参照先を残す。

上流は Claude Agent SDK（約 224MB）を `~/.live-mindmap/deps/` に `cli install` で入れ、プロセスグループで子孫の寿命を追う（上流 ADR 0017）。この導入ランナーは `process.platform === "win32"` で明示的に例外を投げ、Windows では使えない。Job Object などで Windows 対応にする道もあるが、Chromium（map.png）をコア範囲から外せば重い依存は SDK だけになるので、SDK を通常の `dependencies` に戻し、管理ディレクトリと導入ランナーを丸ごと外す。「会議中に入れない」という上流の約束は、`pnpm install` の時点で入っていることで自動的に満たす。

## Consequences

- clone 直後の `pnpm install` が重くなる（SDK のバイナリ込み）
- `cli install` / `cli update` は無くなる。開始前の確かめ（`cli check`・`start` の直前）はヘルパーの `check` だけを見て、マイクの許可か端末内 STT のモデルが欠けていれば exit 3 で始めない（上流の exit 3 の約束はそのまま。入れるのは利用者が確かめてから）
- pnpm は `node-linker=hoisted` にする（NTFS 上のシンボリックリンクを避ける）
