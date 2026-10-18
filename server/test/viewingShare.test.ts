// 閲覧の共有（ADR 0003）の純粋な部分。状態の型、LAN の URL の組み立て、cli の表示。
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { formatShareOpened, formatShareStatus, ShareStatus, viewingUrls } from "../src/core/index.ts";

const open = { status: "open", urls: ["http://192.168.1.5:4320/?pin=012345", "http://100.64.0.2:4320/?pin=012345"], pin: "012345" } as const;

describe("ShareStatus（状態の型は 2 つ）", () => {
  const decode = Schema.decodeUnknownSync(ShareStatus);

  it("無し・共有中 を読める。共有中の URL は空でもよい（LAN のアドレスが無いとき）", () => {
    expect(decode({ status: "off" })).toEqual({ status: "off" });
    expect(decode(open)).toEqual(open);
    expect(decode({ ...open, urls: [] })).toEqual({ ...open, urls: [] });
  });

  it("未知の状態、PIN が 6 桁の数字でない共有中、URL の無い共有中は読めない", () => {
    expect(() => decode({ status: "broken" })).toThrow();
    expect(() => decode({ ...open, pin: "12345" })).toThrow();
    expect(() => decode({ ...open, pin: "abcdef" })).toThrow();
    expect(() => decode({ status: "open", pin: "012345" })).toThrow();
  });
});

describe("viewingUrls", () => {
  it("アドレスごとに http://<アドレス>:<ポート>/?pin=<PIN> を作る。アドレスが無ければ空", () => {
    expect(viewingUrls(["192.168.1.5", "100.64.0.2"], 4320, "012345")).toEqual(open.urls);
    expect(viewingUrls([], 4320, "012345")).toEqual([]);
  });
});

describe("cli の表示", () => {
  it("formatShareStatus: 無しは「閲覧の共有: 無し」の 1 行", () => {
    expect(formatShareStatus({ status: "off" }).trimEnd()).toBe("閲覧の共有: 無し");
  });

  it("formatShareStatus: 共有中は状態・URL（アドレスごと）・PIN を行で出す", () => {
    expect(formatShareStatus(open).trimEnd().split("\n")).toEqual([
      "閲覧の共有: 共有中", `URL: ${open.urls[0]}`, `URL: ${open.urls[1]}`, "PIN: 012345",
    ]);
  });

  it("formatShareOpened: URL・PIN・Firewall の案内・閉じ方を出す", () => {
    const text = formatShareOpened(open);
    for (const url of open.urls) expect(text).toContain(url);
    expect(text).toContain("PIN: 012345");
    expect(text).toContain("Firewall");
    expect(text).toContain("--stop");
  });

  it("LAN のアドレスが無いときは、URL の代わりにその旨を出す", () => {
    const none = { ...open, urls: [] };
    expect(formatShareStatus(none)).toContain("LAN のアドレスが見つかりません");
    expect(formatShareOpened(none)).toContain("LAN のアドレスが見つかりません");
    expect(formatShareOpened(none)).not.toContain("URL:");
  });
});
