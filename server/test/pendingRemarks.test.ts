// 取り込み待ちのフレーム（map-update-latency タスク 6.1）の純粋な部分。
// 組み立て、確定による仮の項目の置き換え、中身なし・重複の除外、同値比較、期限で外す関数。
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CLOSING_TIMEOUT_MS,
  dropExpiredPending,
  FAILED_SHOW_MS,
  PENDING_TEXT_MAX,
  PendingRemarksFrame,
  pendingRemarksFrame,
  samePendingRemarksFrame,
  type ClosingSegment,
  type Remark,
  type SettledRemark,
} from "../src/core/index.ts";

type Input = Parameters<typeof pendingRemarksFrame>[0];
const empty: Input = { closing: [], held: [], queued: [], reflecting: [], failed: [], since: new Map() };
const frame = (over: Partial<Input>) => pendingRemarksFrame({ ...empty, ...over });

const closing = (over: Partial<ClosingSegment> = {}): ClosingSegment => ({
  track: "自分", start: 12, end: 14, partialText: "それは", at: 1000, ...over,
});
const remark = (id: string, over: Partial<Remark> = {}): Remark => ({
  id, track: "自分", start: 12, end: 14, text: "それは来週です", ...over,
});
const settled = (over: Partial<SettledRemark> = {}): SettledRemark => ({
  track: "自分", start: 30, end: 32, text: "では始めます", ...over,
});

describe("PendingRemarksFrame（Schema は core の barrel から出る）", () => {
  const decode = Schema.decodeUnknownSync(PendingRemarksFrame);
  const item = { key: "自分:12", track: "自分", text: "", start: 12, end: 14, since: 0 };

  it("5 つの状態をすべて読める。id と speaker は無くてもよい", () => {
    for (const state of ["closing", "waiting", "queued", "reflecting", "failed"]) {
      const f = { type: "pending-remarks", remarks: [{ ...item, state }] };
      expect(decode(f)).toEqual(f);
    }
    const withIds = { type: "pending-remarks", remarks: [{ ...item, state: "queued", id: "r1", speaker: "相手 A" }] };
    expect(decode(withIds)).toEqual(withIds);
  });

  it("未知の状態・未知の type は読めない", () => {
    expect(() => decode({ type: "pending-remarks", remarks: [{ ...item, state: "done" }] })).toThrow();
    expect(() => decode({ type: "other", remarks: [] })).toThrow();
  });
});

describe("pendingRemarksFrame（組み立て）", () => {
  it("入力が空なら remarks も空。type は pending-remarks", () => {
    expect(frame({})).toEqual({ type: "pending-remarks", remarks: [] });
  });

  it("5 状態を 1 つのフレームに音声の終わりの順で組む。closing の本文は途中結果、無ければ空", () => {
    const f = frame({
      closing: [closing({ track: "相手", start: 50, end: 52, partialText: "途中" }), closing({ track: "相手", start: 60, end: 62, partialText: undefined })],
      held: [settled({ start: 30, end: 32 })],
      queued: [remark("r2", { start: 20, end: 22, text: "二つ目" })],
      reflecting: [remark("r1", { start: 10, end: 12, text: "一つ目" })],
      failed: [remark("r3", { start: 40, end: 42, text: "失敗した" })],
    });
    expect(f.remarks.map((r) => [r.state, r.key, r.text, r.end])).toEqual([
      ["reflecting", "r1", "一つ目", 12],
      ["queued", "r2", "二つ目", 22],
      ["waiting", "自分:30", "では始めます", 32],
      ["failed", "r3", "失敗した", 42],
      ["closing", "相手:50", "途中", 52],
      ["closing", "相手:60", "", 62],
    ]);
  });

  it("id を持つ項目は id と speaker を運ぶ。closing と waiting は id を持たない", () => {
    const f = frame({
      closing: [closing({ start: 70, end: 72 })],
      held: [settled({ start: 30, end: 32, speaker: "相手 A" })],
      queued: [remark("r2", { start: 20, end: 22, speaker: "自分" })],
    });
    const [q, w, c] = f.remarks;
    expect(q).toMatchObject({ key: "r2", id: "r2", speaker: "自分", track: "自分", start: 20, end: 22 });
    expect(w).toMatchObject({ state: "waiting", speaker: "相手 A" });
    expect(w).not.toHaveProperty("id");
    expect(c).not.toHaveProperty("id");
  });

  it("end が同じなら入力の順を保つ", () => {
    const f = frame({ queued: [remark("b", { end: 9 }), remark("a", { end: 9 }), remark("c", { end: 5 })] });
    expect(f.remarks.map((r) => r.key)).toEqual(["c", "b", "a"]);
  });

  it("同じ ID が複数の集合に入っても 1 件だけ出す。優先は failed、reflecting、queued", () => {
    const r = remark("r1");
    expect(frame({ queued: [r], reflecting: [r] }).remarks.map((x) => x.state)).toEqual(["reflecting"]);
    expect(frame({ queued: [r], failed: [r] }).remarks.map((x) => x.state)).toEqual(["failed"]);
    expect(frame({ reflecting: [r], failed: [r] }).remarks.map((x) => x.state)).toEqual(["failed"]);
    expect(frame({ queued: [r], reflecting: [r], failed: [r] }).remarks).toHaveLength(1);
  });

  it("同じ track・start の closing が 2 つあっても 1 件にする", () => {
    expect(frame({ closing: [closing(), closing({ partialText: "それは来" })] }).remarks).toHaveLength(1);
  });

  it("本文は PENDING_TEXT_MAX 文字で切る。サロゲートペアを壊さない", () => {
    const long = "あ".repeat(PENDING_TEXT_MAX + 10);
    expect(frame({ queued: [remark("r1", { text: long })] }).remarks[0]?.text).toBe("あ".repeat(PENDING_TEXT_MAX));
    const emoji = "😀".repeat(PENDING_TEXT_MAX + 1);
    expect(frame({ closing: [closing({ partialText: emoji })] }).remarks[0]?.text).toBe("😀".repeat(PENDING_TEXT_MAX));
    const exact = "い".repeat(PENDING_TEXT_MAX);
    expect(frame({ queued: [remark("r1", { text: exact })] }).remarks[0]?.text).toBe(exact);
  });

  it("since は鍵（ID、無ければ track:start）で引く。無ければ closing は at、ほかは 0", () => {
    const f = frame({
      closing: [closing({ start: 70, end: 72, at: 4000 })],
      held: [settled({ start: 30, end: 32 })],
      queued: [remark("r2", { start: 20, end: 22 })],
      reflecting: [remark("r1", { start: 10, end: 12 })],
      since: new Map([["r1", 9000], ["自分:30", 8000]]),
    });
    expect(f.remarks.map((r) => [r.key, r.since])).toEqual([
      ["r1", 9000], ["r2", 0], ["自分:30", 8000], ["自分:70", 4000],
    ]);
  });
});

describe("pendingRemarksFrame（確定による仮の項目の置き換え）", () => {
  it("同じ track・start の確定があれば closing は出ず、確定の項目が 1 件出る（held・queued・reflecting のどれでも）", () => {
    const c = closing();
    const q = frame({ closing: [c], queued: [remark("r5")] }).remarks;
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ key: "r5", id: "r5", state: "queued", text: "それは来週です" });
    expect(frame({ closing: [c], reflecting: [remark("r5")] }).remarks.map((r) => [r.key, r.state])).toEqual([["r5", "reflecting"]]);
    expect(frame({ closing: [c], held: [settled({ start: 12, end: 14, text: "それは来週です" })] }).remarks.map((r) => [r.key, r.state, r.text])).toEqual([
      ["自分:12", "waiting", "それは来週です"],
    ]);
    expect(frame({ closing: [c], failed: [remark("r5")] }).remarks.map((r) => r.state)).toEqual(["failed"]);
  });

  it("別 track または別 start の確定では closing は替わらない", () => {
    const f = frame({
      closing: [closing()],
      queued: [remark("r6", { track: "相手" }), remark("r7", { start: 13, end: 15 })],
    });
    expect(f.remarks.map((r) => [r.key, r.state]).sort()).toEqual([
      ["r6", "queued"], ["r7", "queued"], ["自分:12", "closing"],
    ].sort());
    expect(f.remarks).toHaveLength(3);
  });
});

describe("pendingRemarksFrame（中身なし・重複の除外）", () => {
  it("確定が中身なしなら closing も確定も出ない（held・queued・reflecting）", () => {
    const c = closing({ partialText: "えっと" });
    expect(frame({ closing: [c], held: [settled({ start: 12, end: 14, text: "えっと" })] }).remarks).toEqual([]);
    expect(frame({ closing: [c], queued: [remark("r1", { text: "えっと" })] }).remarks).toEqual([]);
    expect(frame({ closing: [c], reflecting: [remark("r1", { text: "えっと" })] }).remarks).toEqual([]);
    expect(frame({ closing: [c], queued: [remark("r1", { text: "" })] }).remarks).toEqual([]);
  });

  it("確定が重複の印つきなら closing も確定も出ない", () => {
    const c = closing();
    expect(frame({ closing: [c], held: [settled({ start: 12, end: 14, duplicate: true })] }).remarks).toEqual([]);
    expect(frame({ closing: [c], queued: [remark("r1", { duplicate: true })] }).remarks).toEqual([]);
  });

  it("中身のない発言・重複の印つきは、通常の発言と並んでいても通常の発言だけが残る", () => {
    const f = frame({
      held: [settled({ start: 1, end: 2, text: "えっと" }), settled({ start: 3, end: 4, text: "では始めます", duplicate: true }), settled({ start: 5, end: 6, text: "はい。では始めます" })],
      queued: [remark("q1", { start: 7, end: 8, text: "" }), remark("q2", { start: 9, end: 10, text: "賛成" })],
      reflecting: [remark("x1", { start: 11, end: 12, duplicate: true })],
    });
    expect(f.remarks.map((r) => [r.key, r.state])).toEqual([["自分:5", "waiting"], ["q2", "queued"]]);
  });

  it("同じ文字でも中身のある別の発言は出る", () => {
    const f = frame({ held: [settled({ start: 21, end: 22, text: "はい。では始めます" })] });
    expect(f.remarks.map((r) => r.state)).toEqual(["waiting"]);
  });

  it("取り込み中の発言は仮の項目の代わりに 1 件出て、反映か noop で集合から外れると出なくなる", () => {
    const shown = frame({ closing: [closing()], reflecting: [remark("r1")] });
    expect(shown.remarks.map((r) => [r.key, r.state])).toEqual([["r1", "reflecting"]]);
    // 反映・noop のどちらでも、純粋関数から見えるのは「どの集合にも入っていない」こと。仮の項目の取り除きは呼び出し側の仕事
    expect(frame({}).remarks).toEqual([]);
  });
});

describe("pendingRemarksFrame（取り込めなかった）", () => {
  it("failed の発言は state failed で出る。queued として出さない", () => {
    const f = frame({ failed: [remark("r9", { text: "入らなかった" })], since: new Map([["r9", 500]]) });
    expect(f.remarks).toEqual([
      { key: "r9", id: "r9", track: "自分", text: "入らなかった", start: 12, end: 14, state: "failed", since: 500 },
    ]);
  });
});

describe("samePendingRemarksFrame（同じ中身かの比べ）", () => {
  const base = () => frame({ queued: [remark("r1", { end: 14 }), remark("r2", { start: 20, end: 22 })], closing: [closing({ start: 40, end: 42 })] });

  it("同じ入力から別々に組んだ 2 つは同じ", () => {
    const a = base();
    const b = base();
    expect(a).not.toBe(b);
    expect(samePendingRemarksFrame(a, b)).toBe(true);
    expect(samePendingRemarksFrame(frame({}), frame({}))).toBe(true);
  });

  it("state・text・件数・id・key・speaker の違いは別", () => {
    const a = frame({ queued: [remark("r1")] });
    expect(samePendingRemarksFrame(a, frame({ reflecting: [remark("r1")] }))).toBe(false);
    expect(samePendingRemarksFrame(a, frame({ queued: [remark("r1", { text: "それは再来週です" })] }))).toBe(false);
    expect(samePendingRemarksFrame(a, frame({ queued: [remark("r1"), remark("r2", { start: 20, end: 22 })] }))).toBe(false);
    expect(samePendingRemarksFrame(a, frame({}))).toBe(false);
    expect(samePendingRemarksFrame(a, frame({ queued: [remark("r2")] }))).toBe(false);
    expect(samePendingRemarksFrame(a, frame({ queued: [remark("r1", { speaker: "相手 A" })] }))).toBe(false);
  });

  it("順序の違いは別（remarks は音声の終わりの順なので、並びが替われば表示が替わる）", () => {
    const a = base();
    const reversed = { ...a, remarks: [...a.remarks].reverse() };
    expect(samePendingRemarksFrame(a, reversed)).toBe(false);
  });

  it("since だけが違うものは同じ（since は状態が替わるときにしか替わらず、替われば state で別になる）", () => {
    const a = frame({ queued: [remark("r1")], since: new Map([["r1", 100]]) });
    const b = frame({ queued: [remark("r1")], since: new Map([["r1", 200]]) });
    expect(samePendingRemarksFrame(a, b)).toBe(true);
  });
});

describe("dropExpiredPending（期限の時刻で外す）", () => {
  const f = () => frame({
    closing: [closing({ start: 1, end: 2, at: 10_000 })],
    failed: [remark("f1", { start: 3, end: 4 })],
    held: [settled({ start: 5, end: 6 })],
    queued: [remark("q1", { start: 7, end: 8 })],
    reflecting: [remark("g1", { start: 9, end: 10 })],
    since: new Map([["f1", 20_000], ["自分:5", 0], ["q1", 0], ["g1", 0]]),
  });
  const states = (x: ReturnType<typeof f>) => x.remarks.map((r) => r.state);

  it("closing は at + CLOSING_TIMEOUT_MS を過ぎると外れ、手前なら残る", () => {
    const edge = 10_000 + CLOSING_TIMEOUT_MS;
    expect(states(dropExpiredPending(f(), edge - 1))).toContain("closing");
    expect(states(dropExpiredPending(f(), edge))).not.toContain("closing");
    expect(states(dropExpiredPending(f(), edge + 1))).not.toContain("closing");
  });

  it("failed は since + FAILED_SHOW_MS を過ぎると外れ、手前なら残る", () => {
    const edge = 20_000 + FAILED_SHOW_MS;
    expect(states(dropExpiredPending(f(), edge - 1))).toContain("failed");
    expect(states(dropExpiredPending(f(), edge))).not.toContain("failed");
    expect(states(dropExpiredPending(f(), edge + 1))).not.toContain("failed");
  });

  it("waiting・queued・reflecting は期限で外れない（どれだけ遅くても）", () => {
    expect(states(dropExpiredPending(f(), 10 ** 12))).toEqual(["waiting", "queued", "reflecting"]);
  });

  it("入力のフレームは変えず、残る項目の順も保つ", () => {
    const input = f();
    const before = input.remarks.length;
    const out = dropExpiredPending(input, 10 ** 12);
    expect(input.remarks).toHaveLength(before);
    expect(out.type).toBe("pending-remarks");
    expect(out.remarks.map((r) => r.key)).toEqual(["自分:5", "q1", "g1"]);
  });

  it("期限の定数は設計の値（closing 3 秒・failed 5 秒）", () => {
    expect(CLOSING_TIMEOUT_MS).toBe(3000);
    expect(FAILED_SHOW_MS).toBe(5000);
  });
});
