# Android は同じ LAN から Windows の server をブラウザで見るだけにし、トンネルは使わない

上流の iPad は `cli share`（cloudflared トンネル・メールの PIN）でマップを見ていた。cloudflared の取得は macOS 専用で、トンネルと認証はコア体験の外にある。この製品では Android 専用のアプリを作らず、上流の web（スマホ幅対応済み）をそのまま、server の閲覧の口を LAN に向けて開いて見せる。接続は PIN か QR で絞る。外出先から見る需要が出たら、トンネルはその上に足す。

## Consequences

- server の閲覧の口は 127.0.0.1 だけでなく LAN のアドレスでも待ち受ける（操作の口は 127.0.0.1 のまま）。Origin の検査はそれに合わせて緩める
- Windows Firewall の受信許可が要る。初回の案内に含める
- Android 側に置くものは無い。ブラウザの対応だけを確かめる
- 利用者の環境では Tailscale が常時動いていて、LAN 向けと同じ待ち受け（全インターフェース）で tailnet 越しにも届く。コードに Tailscale 固有の対応は入れない（外出先はこれで足りるので、トンネルの需要はさらに遠のく）
