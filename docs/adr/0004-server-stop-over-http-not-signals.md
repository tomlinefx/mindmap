# cli server stop はシグナルではなく POST /server/stop でサーバー自身に終了を求める

上流の `cli server stop` は、ポートで応答したサーバーが名乗った PID に SIGTERM を送り、runMain の中断で Scope を閉じて後片付け（PID の記録の削除・配信の渡し切り・待受けの閉じ）をしていた。Windows にはシグナルが無く、Node の `process.kill(pid, "SIGTERM")` は TerminateProcess（後片付け無しの強制終了。終了コード 1、PID の記録が残る）になる。そこで、CLI と server が共有する経路（上流 ADR 0023）に `POST /server/stop` を足し、CLI はシグナルを送らずにこれで終了を求め、名乗った PID が終わるのを待つ。server は 204 を返してから少し（100 ms）おいて、SIGINT・SIGTERM と同じ Scope の閉じ方で終わる（終了コード 0）。

止める相手の決め方（応答したサーバーだけを止め、記録の PID だけでは止めない。`planServerStop`）は変えない。応答が無いのに記録の PID が生きているときは、今までどおり何もせずに断る。

## Consequences

- `ServerProcess` に残るのは生存の確認（シグナル 0）だけ。Windows でも有無の確認には使える
- SIGINT・SIGTERM での終了（Ctrl-C）は POSIX ではそのまま使える。Windows の Ctrl-C は Node の SIGINT の模倣で届くが、`win-dev-stop.cmd` の taskkill は強制終了のまま（進行中のセッションは書き出されない。先に `cli stop`）
- heavy IT のうち、シグナルの振る舞いそのもの（SIGINT/SIGTERM での終了、SIGTERM を無視するヘルパーの SIGKILL への切り替え）は Windows では確かめられないので skip する。自分への SIGKILL は Windows では code 1・signal 無しとして観測される
