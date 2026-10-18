# mindmap

会議の発言から AI が継続的にマインドマップを組み立てる Windows アプリ。会議アプリの音とマイクを端末内で文字にし、Claude がマップを差分更新し、Windows のブラウザと同じ LAN の Android で見る。元プロジェクト live-mindmap（MIT）の Windows + Android 版。語彙は [CONTEXT.md](CONTEXT.md)、決定は [docs/adr/](docs/adr/)。

## 要るもの

- Windows 10 2004 以降（会議アプリの音だけを取る WASAPI Process Loopback のため）
- Node.js と pnpm、.NET 10 SDK
- Claude の API キー（環境変数 `ANTHROPIC_API_KEY`。差分更新に使う。音声は PC の外に出ないが、発言の文字は Claude に送る）
- 設定 > プライバシーとセキュリティ > マイク で、デスクトップ アプリにマイクの許可
- エコーキャンセルの dll を作るときだけ、Visual Studio の「C++ によるデスクトップ開発」（無くても動く。下記）

## 初回の準備

```
pnpm install
scripts\win-helper-build.cmd          # ヘルパー（C#）を Release でビルドする
scripts\win-stt-models.cmd            # 端末内 STT のモデル（約 150 MB）を %LOCALAPPDATA%\mindmap\models\stt に入れる
scripts\win-webrtc-apm.cmd            # 任意: エコーキャンセル（WebRTC AEC3）の dll を作り、もう一度 win-helper-build.cmd
```

そろったかは `cd server` して `node src/cli.ts check` で見る（マイクの許可と STT のモデルが ready なら始められる）。

## 会議のたびに

### 1. 始める

会議アプリで会議に入ってから、次を実行する（ダブルクリックでもよい）。

```
scripts\win-meeting-start.cmd
```

これだけで、常駐サーバーと画面を起こし、音を出している会議アプリを自動で選び、セッションを開始し、Android 用の URL を出し、ブラウザで画面を開く。音を出しているアプリが無いか複数あるときは候補を出して止まるので、アプリ名（実行ファイル名）と、付けたければ会議の名前を渡す。

```
scripts\win-meeting-start.cmd Zoom.exe "週次定例"
```

- 会議アプリは Windows で音を出すアプリならどれでもよい（Zoom、Teams は `ms-teams.exe`、Webex、Discord など）。ブラウザの会議（Google Meet など）は `chrome.exe` や `msedge.exe` を選ぶ。そのアプリの音だけを取るので、ほかのアプリの通知音などは混ざらない
- 開始の時点でそのアプリが起動している必要がある。起動していないと、知らせたうえで再生デバイス全体の音を取る
- 会議の途中で会議アプリを終了して起動し直すと音が届かなくなる（10 秒で「相手の音が届いていない」の知らせが出る）。そのときは終えてから始め直す

### 2. 会議中

- 画面（http://localhost:5173/ ）には、マップと、下に字幕（まだマップに入っていない発言と途中結果）が出る。カメラは今の議題に寄る
- Android は `start` が出した URL（`http://192.168.11.2:4320/?pin=...` のような形。Tailscale 越しなら 100.x のほう）をブラウザで開く。見るだけで操作はできない。初回は Windows Firewall の受信の許可を求められるので、プライベート ネットワークで許可する
- 自分（マイク）の声は「自分」、会議アプリの音は「相手」として別のトラックで扱う。スピーカーで聞いていて相手の声がマイクに漏れたぶんは、エコーキャンセルで消し、消し残りは重複の印を付けて字幕にもマップにも出さない
- 自分の声を取りたくない間は `M` で休止する（会議アプリのミュートとは別）

画面のキー（`?` で一覧）:

| キー | はたらき |
|---|---|
| `Esc` | 今の議題へ戻る。開いたり畳んだりした状態を元に戻す |
| `F` | 全体を見る。もう一度で、変わったところへ寄る |
| `= / -`、`0` | 拡大・縮小、倍率 1.0 |
| `← → ↑ ↓`、`Enter`、`Z` | ノードを選ぶ、選んだ議題を開く・畳む、選んだノードに寄る |
| `Shift + 矢印` | 画面を動かす |
| `E` | 右の列（変わったこと・根拠）を出す・隠す |
| `C` | 字幕を出す・隠す |
| `M` | 自分を休止・再開 |

途中の様子はコマンドでも見られる（`cd server` で）。

```
node src/cli.ts status      # 取り込みの状態と共有の URL
node src/cli.ts export      # その時点のマップを Markdown で出す（--format json も）
node src/cli.ts resume      # 取り込みが「止まった」になったとき、ヘルパーを起動し直して続ける
```

### 3. 終える

```
scripts\win-meeting-stop.cmd
```

セッションを終了し、書き出した場所を出す。閲覧の共有もここで閉じる。常駐サーバーと画面は次の会議のために残るので、PC を片付けるときは `scripts\win-meeting-stop.cmd -StopServer`。

Claude Code からは `/mindmap-start` と `/mindmap-stop` で同じことができる。

## 残るもの

セッションごとに `%USERPROFILE%\.live-mindmap\sessions\<開始時刻>\` に残る。音声は残さない（ADR 0001）。

| ファイル | 中身 |
|---|---|
| `map.md` | 人が読む要約。決定・TODO・未決の論点・アウトライン（議題と要点の木、時刻つき） |
| `map.json` | マップ全体。ノードの種別・本文・根拠の発言（話者・時刻・原文） |
| `map.html` | ブラウザで開く見返し用の画面。サーバー無しで、発言をたどりながら見返せる |
| `map.drawnix` | 図のツール用 |
| `log.jsonl` | 発言と差分更新の全記録。`node src/cli.ts restore` でマップを戻せる |
| `export.json` | その時点のマップ（会議中も更新される） |

`map.*` は終えるときに書く。終え忘れても `log.jsonl` と `export.json` は残っているので、後から `restore` と `export` で取り出せる。過去のセッションは `node src/cli.ts play <セッションのフォルダ>` で発言を流し直して、差分更新をやり直せる。

## うまくいかないとき

- 相手の発言が出ない: 会議アプリを選べているか `node src/cli.ts status` と `.dev\server.err.log` の「取得を始めました（…相手: …）」の行で見る。再生デバイス全体になっていたら、会議アプリを起動してから始め直す。会議アプリの音量を 0 にしていると届かない
- 自分の発言が出ない: マイクの許可（`check`）と、`M` で休止していないか
- 字幕は出るのにマップが増えない: 差分更新のモデル（Claude）の認証か利用上限。利用上限で待っているときは「一時停止」で、発言は失わずに戻ったら反映する
- 始められない（exit 3）: `check` が示す足りないもの（ヘルパーのビルド・マイクの許可・STT のモデル）を入れる
- 「セッションが進行中です」: 前の会議を終えていない。`scripts\win-meeting-stop.cmd` を先に
- Android で開けない: Wi-Fi が同じか、Windows Firewall でプライベート ネットワークの受信を許可したか。URL の `?pin=` を消していないか

## ライセンス

MIT（[LICENSE](LICENSE)）。server と web は live-mindmap（Copyright (c) 2026 Daiki Beppu、MIT）からコピーしたもので、その著作権表示をそのまま残している。helper と Windows 向けの追加分も同じ MIT で出す。ビルドで取り込む第三者（WebRTC、sherpa-onnx、音声認識のモデルなど）の一覧と表示は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。実行ファイルを配るときは、`dotnet build` が隣に写す `LICENSE`・`THIRD_PARTY_NOTICES.md`・`LICENSES/` を一緒に配る（[ADR 0005](docs/adr/0005-license-mit-with-third-party-notices.md)）。

## 構成

- `server/`: 常駐サーバーと CLI（Node、上流からコピー）。差分更新・セッション・ログ・書き出し
- `web/`: 表示（上流からコピー）。会議中の画面と見返しの画面
- `helper/`: Windows のヘルパー（C# / .NET 10）。音の取得・端末内 STT・エコーキャンセル。詳しくは [helper/README.md](helper/README.md)
- `scripts/`: Windows 向けの起動・検証スクリプト。開発の手順は [CLAUDE.md](CLAUDE.md)
