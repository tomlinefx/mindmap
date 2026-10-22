// 遅れの集計（latencyReport）。固定のログから決まった中央値・p90 が出ること、本文を替えても結果が同じことを、合成した行で確かめる。
// 中央値と p90 は線形補間（n 個を昇順に並べ、位置 (n-1)*q の前後を按分する）。
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { formatLatencyTable, latencyReport } from "../src/core/latency.ts";
import { dataRows, isUnmeasured, rowOf, tableRows, UNMEASURED } from "./fixtures/latencyTable.ts";

const W = 1_000_000; // origin の壁時計（Unix ms）
const iso = (ms: number) => new Date(ms).toISOString();

type Track = "自分" | "相手";
type Timing = { end: number; settle?: number; speakerWait?: number; callWait?: number; call?: number; shown?: number; text?: string };

// 発言 1 件と、それだけを fresh にした成功の diff 1 件の行。各区間の長さ（ms）を指定する。diff の at は呼び出しの終わりの 50ms 後
function rows(id: string, track: Track, t: Timing, diffExtra: Record<string, unknown> = {}): unknown[] {
  const speechEnd = W + t.end * 1000;
  const settledAt = t.settle === undefined ? undefined : speechEnd + t.settle;
  const pushAt = settledAt === undefined || t.speakerWait === undefined ? speechEnd + 1 : settledAt + t.speakerWait;
  const callStart = pushAt + (t.callWait ?? 0);
  const callEnd = callStart + (t.call ?? 0);
  const text = t.text ?? `発言 ${id}`;
  return [
    {
      type: "remark",
      remark: { id, track, start: t.end - 1, end: t.end, text },
      raw: text,
      words: [{ text, start: t.end - 1, end: t.end }],
      ...(settledAt === undefined ? {} : { settledAt }),
      ...(t.shown === undefined ? {} : { shownAt: speechEnd + t.shown }),
      at: iso(pushAt),
    },
    {
      type: "diff",
      input: { recent: [], fresh: [id], nodeCount: 0 },
      ops: [],
      dropped: [],
      at: iso(callEnd + 50),
      ...(t.call === undefined ? {} : { call: { startedAt: iso(callStart), endedAt: iso(callEnd) } }),
      ...diffExtra,
    },
  ];
}

const origin = { type: "origin", wallTime: W, at: iso(W) };
const run = (events: unknown[]) => Effect.runSync(latencyReport(events));

// 自分 4 件（n=4 の按分）と 相手 1 件（n=1）
function fixedLog(textOf: (id: string) => string = (id) => `発言 ${id}`): unknown[] {
  const m = (id: string, end: number, settle: number, speakerWait: number, callWait: number, call: number, shown: number) =>
    ({ end, settle, speakerWait, callWait, call, shown, text: textOf(id) });
  return [
    { type: "start", title: "講演" },
    origin,
    ...rows("a1", "自分", m("a1", 10, 1000, 10, 100, 5000, 800)),
    ...rows("a2", "自分", m("a2", 20, 2000, 20, 200, 6000, 900)),
    ...rows("a3", "自分", m("a3", 30, 3000, 30, 300, 7000, 1000)),
    ...rows("a4", "自分", m("a4", 40, 4000, 40, 400, 8000, 1100)),
    ...rows("b1", "相手", m("b1", 50, 500, 5, 50, 900, 300)),
  ];
}

describe("latencyReport: 区間ごと・トラックごとの中央値と p90", () => {
  it("固定のログから、自分の 区間ごとの n・中央値・p90・最大が決まった値で出る（偶数 n は中央の 2 つの平均、p90 は位置 (n-1)*0.9 の按分）", () => {
    const report = run(fixedLog());

    expect(report.measured).toBe(true);
    const mine = report.byTrack["自分"];
    // applied = settle + speakerWait + callWait + call + 50: 6160, 8270, 10380, 12490
    const expected = {
      shown: { n: 4, median: 950, p90: 1070, max: 1100 },
      applied: { n: 4, median: 9325, p90: 11857, max: 12490 },
      settled: { n: 4, median: 2500, p90: 3700, max: 4000 },
      speakerWait: { n: 4, median: 25, p90: 37, max: 40 },
      callWait: { n: 4, median: 250, p90: 370, max: 400 },
      call: { n: 4, median: 6500, p90: 7700, max: 8000 },
    } as const;
    for (const [interval, stats] of Object.entries(expected)) {
      const actual = mine[interval as keyof typeof mine];
      expect(actual?.n, interval).toBe(stats.n);
      expect(actual?.median, interval).toBeCloseTo(stats.median, 6);
      expect(actual?.p90, interval).toBeCloseTo(stats.p90, 6);
      expect(actual?.max, interval).toBe(stats.max);
    }
  });

  it("トラックを混ぜない。相手の 1 件だけの区間は n=1 で、中央値・p90・最大が同じ値になる", () => {
    const theirs = run(fixedLog()).byTrack["相手"];

    expect(theirs.shown).toEqual({ n: 1, median: 300, p90: 300, max: 300 });
    expect(theirs.settled).toEqual({ n: 1, median: 500, p90: 500, max: 500 });
    expect(theirs.speakerWait).toEqual({ n: 1, median: 5, p90: 5, max: 5 });
    expect(theirs.callWait).toEqual({ n: 1, median: 50, p90: 50, max: 50 });
    expect(theirs.call).toEqual({ n: 1, median: 900, p90: 900, max: 900 });
    expect(theirs.applied).toEqual({ n: 1, median: 5 + 500 + 50 + 900 + 50, p90: 1505, max: 1505 });
  });

  it("本文（text・raw・words）を別の文字列に替えても、結果は完全に同じになる", () => {
    const before = run(fixedLog((id) => `予算の話 ${id}`));
    const after = run(fixedLog((id) => `別の本文 ${id} ${"あ".repeat(50)}`));
    const empty = run(fixedLog(() => ""));

    expect(after).toEqual(before);
    expect(empty).toEqual(before);
  });
});

describe("latencyReport: 反映の判定", () => {
  it("失敗した diff・戻した diff の発言は反映済みにせず、後の成功した diff の時刻と呼び出しを使う", () => {
    const [start, r1] = [{ type: "start", title: "講演" }, ...rows("a1", "自分", { end: 10, settle: 100, speakerWait: 10, callWait: 20, call: 1000, shown: 200 })];
    const pushAt = W + 10_000 + 100 + 10;
    const failed = { type: "diff", input: { recent: [], fresh: ["a1"], nodeCount: 0 }, ops: [], dropped: [], error: "失敗", at: iso(pushAt + 90_000), call: { startedAt: iso(pushAt + 80_000), endedAt: iso(pushAt + 90_000) } };
    const requeued = { type: "diff", input: { recent: [], fresh: ["a1"], nodeCount: 0 }, ops: [], dropped: [], requeued: true, at: iso(pushAt + 70_000), call: { startedAt: iso(pushAt + 60_000), endedAt: iso(pushAt + 70_000) } };
    const okStart = pushAt + 5000;
    const ok = { type: "diff", input: { recent: [], fresh: ["a1"], nodeCount: 0 }, ops: [], dropped: [], at: iso(okStart + 300 + 50), call: { startedAt: iso(okStart), endedAt: iso(okStart + 300) } };

    const mine = run([start, origin, r1, failed, requeued, ok]).byTrack["自分"];

    expect(mine.applied).toEqual({ n: 1, median: 100 + 10 + 5000 + 300 + 50, p90: 5460, max: 5460 });
    expect(mine.callWait).toEqual({ n: 1, median: 5000, p90: 5000, max: 5000 });
    expect(mine.call).toEqual({ n: 1, median: 300, p90: 300, max: 300 });
  });

  it("どの成功した diff にも入らなかった発言は、反映・呼び出し待ち・呼び出しに数えない（表示・締まり・話者待ちは数える）", () => {
    const log = [
      { type: "start", title: "講演" },
      origin,
      ...rows("a1", "自分", { end: 10, settle: 100, speakerWait: 10, callWait: 20, call: 1000, shown: 200 }, { error: "失敗" }),
    ];

    const mine = run(log).byTrack["自分"];

    expect(mine.applied).toBeUndefined();
    expect(mine.callWait).toBeUndefined();
    expect(mine.call).toBeUndefined();
    expect(mine.shown?.n).toBe(1);
    expect(mine.settled?.n).toBe(1);
    expect(mine.speakerWait?.n).toBe(1);
  });

  it("processedRemarks が 1 の diff は、fresh の先頭の発言だけを反映済みにする。残りは後の diff で反映する", () => {
    const [start, r1, , r2] = [{ type: "start", title: "講演" }, ...rows("a1", "自分", { end: 10, settle: 100, speakerWait: 0, shown: 100 }), ...rows("a2", "自分", { end: 20, settle: 100, speakerWait: 0, shown: 100 })];
    const first = { type: "diff", input: { recent: [], fresh: ["a1", "a2"], nodeCount: 0 }, ops: [], dropped: [], processedRemarks: 1, at: iso(W + 30_000) };
    const second = { type: "diff", input: { recent: [], fresh: ["a2"], nodeCount: 0 }, ops: [], dropped: [], at: iso(W + 50_000) };

    const mine = run([start, origin, r1, r2, first, second]).byTrack["自分"];

    // a1: 30000 - 10000 = 20000、a2: 50000 - 20000 = 30000（最初の diff では反映されない）
    expect(mine.applied).toEqual({ n: 2, median: 25000, p90: 29000, max: 30000 });
  });
});

describe("latencyReport: 計測なし", () => {
  it("origin の行が無いログは measured が false で、どちらのトラックのどの区間も計測なし", () => {
    const withoutOrigin = fixedLog().filter((e) => (e as { type: string }).type !== "origin");

    const report = run(withoutOrigin);

    expect(report.measured).toBe(false);
    for (const track of ["自分", "相手"] as const) {
      for (const stats of Object.values(report.byTrack[track])) expect(stats).toBeUndefined();
    }
  });

  it("wallTime の無い origin の行も同じ（先頭の at や他の行の時刻で代用しない）", () => {
    const noWall = fixedLog().map((e) => ((e as { type: string }).type === "origin" ? { type: "origin", at: iso(W) } : e));

    const report = run(noWall);

    expect(report.measured).toBe(false);
    for (const track of ["自分", "相手"] as const) {
      for (const stats of Object.values(report.byTrack[track])) expect(stats).toBeUndefined();
    }
  });

  it("shownAt の無いログは shown だけが計測なしで、他の区間は出る（0 や失敗にしない）", () => {
    const log = [
      { type: "start", title: "講演" },
      origin,
      ...rows("a1", "自分", { end: 10, settle: 100, speakerWait: 10, callWait: 20, call: 1000 }),
      ...rows("a2", "自分", { end: 20, settle: 300, speakerWait: 10, callWait: 20, call: 2000 }),
    ];

    const mine = run(log).byTrack["自分"];

    expect(mine.shown).toBeUndefined();
    expect(mine.settled).toEqual({ n: 2, median: 200, p90: 280, max: 300 });
    expect(mine.applied?.n).toBe(2);
  });

  it("時刻の項目が無い発言は、その区間の標本だけから外れ、他の区間では数える", () => {
    const log = [
      { type: "start", title: "講演" },
      origin,
      ...rows("a1", "自分", { end: 10, settle: 100, speakerWait: 10, callWait: 20, call: 1000, shown: 200 }),
      ...rows("a2", "自分", { end: 20, speakerWait: 10, callWait: 20, call: 1000 }), // settledAt も shownAt も無い（古いログ）
    ];

    const mine = run(log).byTrack["自分"];

    expect(mine.shown).toEqual({ n: 1, median: 200, p90: 200, max: 200 });
    expect(mine.settled).toEqual({ n: 1, median: 100, p90: 100, max: 100 });
    expect(mine.call?.n).toBe(2);
    expect(mine.applied?.n).toBe(2);
  });

  it("call の無い diff（呼び出しに入らなかった回）は、呼び出し待ち・呼び出しだけが計測なしで、反映は出る", () => {
    const log = [{ type: "start", title: "講演" }, origin, ...rows("a1", "自分", { end: 10, settle: 100, speakerWait: 10, shown: 200 })];

    const mine = run(log).byTrack["自分"];

    expect(mine.callWait).toBeUndefined();
    expect(mine.call).toBeUndefined();
    expect(mine.applied?.n).toBe(1);
  });
});

describe("latencyReport: ログの検査", () => {
  it.effect("既知の種類の行で項目が壊れていれば、その行の位置（0 始まり）の InvalidLogEvent で失敗する", () =>
    Effect.gen(function* () {
      const events = fixedLog();
      const broken = events.map((e, i) => (i === 2 ? { ...(e as object), settledAt: "あとで" } : e));

      const error = yield* Effect.flip(latencyReport(broken));

      expect(error).toMatchObject({ _tag: "InvalidLogEvent", index: 2 });
    }));

  it.effect("時刻として読めない call の文字列も InvalidLogEvent で失敗する", () =>
    Effect.gen(function* () {
      const events = fixedLog();
      const index = events.findIndex((e) => (e as { type: string }).type === "diff");
      const broken = events.map((e, i) => (i === index ? { ...(e as object), call: { startedAt: "昨日", endedAt: "今日" } } : e));

      const error = yield* Effect.flip(latencyReport(broken));

      expect(error).toMatchObject({ _tag: "InvalidLogEvent", index });
    }));

  it("知らない種類の行は読み飛ばし、結果は変わらない", () => {
    const extra = [{ type: "未来の行", at: iso(W), payload: 1 }, ...fixedLog()];

    expect(run(extra)).toEqual(run(fixedLog()));
  });
});

describe("formatLatencyTable: 遅れの表", () => {
  const table = (events: unknown[]) => formatLatencyTable(run(events));

  it("ヘッダーと区切りの行に続いて、トラック（自分・相手）× 6 区間の 12 行が並び、改行で終わる", () => {
    const out = table(fixedLog());

    expect(out.endsWith("\n")).toBe(true);
    const [header, separator] = tableRows(out);
    expect(header).toEqual(expect.arrayContaining(["トラック", "区間", "件数"]));
    expect(header?.join(" ")).toMatch(/中央値.*p90.*最大/);
    expect(separator?.every((cell) => /^-+$/.test(cell))).toBe(true);
    expect(separator).toHaveLength(header!.length);
    const rowsOut = dataRows(out);
    expect(rowsOut.map((cells) => cells[0])).toEqual([...Array(6).fill("自分"), ...Array(6).fill("相手")]);
    expect(rowsOut.every((cells) => cells.length === header!.length)).toBe(true);
  });

  it("固定のログの値（件数・中央値・p90・最大）を、トラックごと・区間ごとの行に整数の ms で出す", () => {
    const out = table(fixedLog());

    expect(rowOf(out, "自分", "shown").slice(2)).toEqual(["4", "950", "1070", "1100"]);
    expect(rowOf(out, "自分", "applied").slice(2)).toEqual(["4", "9325", "11857", "12490"]);
    expect(rowOf(out, "自分", "settled").slice(2)).toEqual(["4", "2500", "3700", "4000"]);
    expect(rowOf(out, "自分", "speakerWait").slice(2)).toEqual(["4", "25", "37", "40"]);
    expect(rowOf(out, "自分", "callWait").slice(2)).toEqual(["4", "250", "370", "400"]);
    expect(rowOf(out, "自分", "call").slice(2)).toEqual(["4", "6500", "7700", "8000"]);
    // トラックを混ぜない
    expect(rowOf(out, "相手", "call").slice(2)).toEqual(["1", "900", "900", "900"]);
    expect(rowOf(out, "相手", "applied").slice(2)).toEqual(["1", "1505", "1505", "1505"]);
  });

  it("小数になる値は切り捨てず四捨五入して整数の ms にする（p90 = 1000.9 は 1001）", () => {
    const log = [
      { type: "start", title: "講演" },
      origin,
      ...rows("a1", "自分", { end: 10, settle: 100, speakerWait: 10, callWait: 20, call: 1000 }),
      ...rows("a2", "自分", { end: 20, settle: 100, speakerWait: 10, callWait: 20, call: 1001 }),
    ];

    expect(rowOf(table(log), "自分", "call")[4]).toBe("1001");
  });

  it("origin の行が無いログは、全 12 行の中央値・p90・最大が「計測なし」になり、NaN・undefined なども出さない", () => {
    const out = table(fixedLog().filter((e) => (e as { type: string }).type !== "origin"));

    const rowsOut = dataRows(out);
    expect(rowsOut).toHaveLength(12);
    for (const cells of rowsOut) expect(isUnmeasured(cells), cells.join("|")).toBe(true);
    expect(out).not.toMatch(/NaN|undefined|Infinity/);
  });

  it("shownAt の無いログは、表示の行だけが計測なしで、反映の行には値が出る。発言の無いトラックは全区間が計測なし", () => {
    const log = [
      { type: "start", title: "講演" },
      origin,
      ...rows("a1", "自分", { end: 10, settle: 100, speakerWait: 10, callWait: 20, call: 1000 }),
    ];
    const out = table(log);

    expect(isUnmeasured(rowOf(out, "自分", "shown"))).toBe(true);
    expect(rowOf(out, "自分", "applied").slice(2)).toEqual(["1", "1180", "1180", "1180"]);
    expect(rowOf(out, "自分", "applied")).not.toContain(UNMEASURED);
    for (const interval of ["shown", "applied", "settled", "speakerWait", "callWait", "call"] as const) expect(isUnmeasured(rowOf(out, "相手", interval)), interval).toBe(true);
  });

  it("流し直しのログ（settledAt・shownAt が無く、origin はある）は、表示・締まり・話者待ちが計測なしで、反映・呼び出し待ち・呼び出しに値が出る", () => {
    const log = [
      { type: "start", title: "講演" },
      origin,
      ...rows("a1", "自分", { end: 10, callWait: 20, call: 1000 }),
      ...rows("a2", "相手", { end: 20, callWait: 30, call: 2000 }),
    ];
    const out = table(log);

    for (const track of ["自分", "相手"] as const) {
      for (const interval of ["shown", "settled", "speakerWait"] as const) expect(isUnmeasured(rowOf(out, track, interval)), `${track} ${interval}`).toBe(true);
      for (const interval of ["applied", "callWait", "call"] as const) expect(rowOf(out, track, interval)[2], `${track} ${interval}`).toBe("1");
    }
  });

  it("本文（text・raw・words）は表に出ない", () => {
    const out = table(fixedLog((id) => `秘密の本文 ${id}`));

    expect(out).not.toContain("秘密の本文");
  });
});
