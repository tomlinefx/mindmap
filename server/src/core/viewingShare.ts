// 閲覧の共有（ADR 0003）の純粋な部分。状態の型、LAN の URL の組み立て、cli の表示。
// 状態は 無し・共有中 の 2 つ（LAN の待受けは tunnel と違って勝手に切れないので、「切れた」は無い）。
import { Schema } from "effect";

// 6 桁の数字の PIN。閲覧の URL に ?pin= で付け、画面を開いたブラウザの Cookie に写す（http.ts の閲覧の口）
export const SharePin = Schema.String.check(Schema.isPattern(/^\d{6}$/));

// 共有中の状態。urls は LAN のインターフェースごとの URL（PIN 付き）。POST /share/open の応答はこの形だけ
export const OpenShareStatus = Schema.Struct({ status: Schema.Literal("open"), urls: Schema.Array(Schema.NonEmptyString), pin: SharePin });
export type OpenShareStatus = typeof OpenShareStatus.Type;

export const ShareStatus = Schema.Union([Schema.Struct({ status: Schema.Literal("off") }), OpenShareStatus]);
export type ShareStatus = typeof ShareStatus.Type;

// 閲覧の URL。アドレスごとに 1 つ（IPv6 は使わない。LAN と tailnet の IPv4 で足りる）
export function viewingUrls(addresses: readonly string[], port: number, pin: string): string[] {
  return addresses.map((address) => `http://${address}:${port}/?pin=${pin}`);
}

const urlLines = (status: OpenShareStatus): string[] =>
  status.urls.length === 0 ? ["LAN のアドレスが見つかりません（ネットワークにつながっていない）"] : status.urls.map((url) => `URL: ${url}`);

// cli status の閲覧の共有の行（取り込みの行の後ろに続ける）
export function formatShareStatus(status: ShareStatus): string {
  if (status.status === "off") return "閲覧の共有: 無し\n";
  return ["閲覧の共有: 共有中", ...urlLines(status), `PIN: ${status.pin}`].join("\n") + "\n";
}

// cli share の標準出力。URL・PIN・初回の Firewall の案内・閉じ方
export function formatShareOpened(status: OpenShareStatus): string {
  return [
    "閲覧の共有を開きました。同じ LAN（または tailnet）の端末のブラウザで、次の URL を開く",
    ...urlLines(status),
    `PIN: ${status.pin}（URL の ?pin= に含めてある。Cookie を消したら付け直す）`,
    "初回は Windows Firewall の受信の許可を求められるので、プライベート ネットワークで許可する",
    "閉じるには share --stop（セッションの終了でも閉じる）",
  ].join("\n") + "\n";
}
