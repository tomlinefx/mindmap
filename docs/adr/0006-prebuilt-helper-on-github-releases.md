# ビルド済みの helper を GitHub Releases に置き、server は %LOCALAPPDATA%\mindmap\helper も見る

helper（C#）を使うには .NET 10 SDK が要り、エコーキャンセルの `webrtc-apm.dll` を作るには Visual Studio の C++ 開発環境と数分のビルドが要る。利用者の PC にこれらを入れさせるのは重いので、helper は作る側（このリポジトリの保守者）がビルドして配る。`scripts/win-release-helper.cmd` が、`webrtc-apm.dll` を用意し、`dotnet publish` を self-contained（.NET ランタイム同梱）で行い、実行ファイル・dll・`LICENSE`・`THIRD_PARTY_NOTICES.md`・`LICENSES/`（ADR 0005）がそろっているか確かめて zip にする。zip は GitHub Releases に `v<版>`（版は csproj の `<Version>`）で上げる。

利用者は zip を `%LOCALAPPDATA%\mindmap\helper` に展開する。server の `resolveHelperPath` は、`LIVE_MINDMAP_HELPER` → リポジトリの Release のビルド → この展開先 の順に見る。リポジトリのビルドを優先するのは、開発中に自分で直した helper が、古い配布物に隠れないようにするため。

server と web は引き続きリポジトリを clone して `pnpm install` で動かす（Node と pnpm は要る）。ここまでで、利用者の PC から .NET SDK と Visual Studio が要らなくなる。画面を server から配る・Node を同梱する・インストーラーを作る、は別の段（README の「ダウンロードして使う」の 2 以降）で、必要になったら ADR を足す。

## Consequences

- self-contained なので zip は大きい（.NET ランタイム込み）。代わりに利用者は .NET ランタイムの導入も要らない
- helper の振る舞いを変えたら csproj の `<Version>` を上げて、新しい zip を Releases に上げる。server と helper の間の形（Events・check の JSON）を変えたときは、古い zip と新しい server が合わなくなるので、Release notes に書く
- 音声認識のモデルは zip に含めない（約 150 MB、Apache-2.0。`scripts/win-stt-models.cmd` で取得する）
- 配布物に第三者の表示を同梱する義務（ADR 0005）は、zip を作る段で確かめる（足りなければ作らない）
