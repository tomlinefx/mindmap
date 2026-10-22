import { describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { DIFF_UPDATE_RETRY_MS, DiffUpdatePaused, InvalidLogEvent, makeSession, restoreSession, restoreState, type DiffInput, type LogEvent, type Remark } from "../src/core/index.ts";
import { collectLog, settleUntil, silentLog, updaterLayer } from "./fixtures/sessionLayers.ts";

// map-update-latency 5.1: 差分更新の呼び出しに時間切れ（20 秒）を張り、失敗・時間切れの回の発言を順番待ち（pending）の先頭へ戻す。
// 再試行は 1 秒から倍に増やして 10 秒まで、成功で 1 秒に戻す。一時停止（利用上限）の扱いは変えない。
// 時間は TestClock で進める。値は仕様の数字をそのまま書く（実装の定数に依らず、仕様との食い違いを検出する）

const remark = (n: number): Remark => ({ id: `r${n}`, track: "相手", start: n, end: n + 1, text: `発言${n}。` });
const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true });

// invalid・result・badcount は応答が返ってきたうえでの失敗（数える）、conn はつながらない失敗（数えない）
type Step = "ok" | "fail" | "hang" | "pause" | "invalid" | "result" | "badcount" | "conn" | "partial";

// n 回目の呼び出しは steps[n-1] の通りに振る舞う。steps を超えたら成功する。時刻は呼び出しの時点の Clock
const setup = Effect.fnUntraced(function* (steps: readonly Step[]) {
  const calls: DiffInput[] = [];
  const callTimes: number[] = [];
  const events: LogEvent[] = [];
  const state = { interrupted: 0 };
  const made = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
    updaterLayer((input) => Effect.gen(function* () {
      calls.push(input);
      callTimes.push(yield* Clock.currentTimeMillis);
      const step = steps[calls.length - 1] ?? "ok";
      if (step === "ok") return { ops: [] };
      if (step === "fail") return yield* Effect.fail({ _tag: "Boom", message: "壊れた" });
      if (step === "invalid") return yield* Effect.fail({ _tag: "DiffOutputInvalid", message: "出力が不正" });
      if (step === "result") return yield* Effect.fail({ _tag: "ClaudeResultFailed", message: "結果が失敗" });
      if (step === "badcount") return { ops: [], processedRemarks: 99 };
      if (step === "partial") return { ops: [], processedRemarks: 1 };
      if (step === "conn") return yield* Effect.fail({ _tag: "ClaudeQueryFailed", message: "つながらない" });
      if (step === "pause") return yield* Effect.fail(new DiffUpdatePaused({ reason: "ChatGPT の利用上限", message: "ChatGPT の利用上限" }));
      return yield* Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { state.interrupted++; })));
    })),
    collectLog(events),
  )));
  const diffs = () => events.flatMap((e) => (e.type === "diff" ? [e] : []));
  return { session: made, calls, callTimes, events, diffs, state };
});

const ids = (input: DiffInput) => input.fresh.map((r) => r.id);

describe("差分更新の失敗からの回復（5.1）", () => {
  it.effect("20 秒を超える呼び出しは、20 秒ちょうどで中断され、失敗として diff の行に残る。発言は処理済みにならない", () => Effect.gen(function* () {
    const { session: s, calls, diffs, state } = yield* setup(["hang"]);
    yield* s.push(remark(1));
    yield* settleUntil(() => calls.length === 1);

    yield* TestClock.adjust(19_999);
    yield* settle;
    expect(diffs()).toHaveLength(0);
    expect(state.interrupted).toBe(0);

    yield* TestClock.adjust(1);
    yield* settleUntil(() => diffs().length === 1);
    expect(diffs()).toHaveLength(1);
    const row = diffs()[0]!;
    expect(row.error).toContain("DiffCallTimeout");
    expect(row.requeued).toBe(true);
    expect(row.call?.startedAt).toBeTypeOf("string");
    expect(row.call?.endedAt).toBeTypeOf("string");
    expect(state.interrupted).toBe(1);
    expect((yield* s.unreflectedRemarks).map((r) => r.id)).toEqual(["r1"]);
  }));

  it.effect("失敗した回の発言は pending の先頭へ戻り、待つ間に届いた発言は後ろに付く。待つ間は呼び出さず、待ち終えた次の呼び出しに一緒に渡す", () => Effect.gen(function* () {
    const { session: s, calls, diffs } = yield* setup(["fail"]);
    yield* s.push(remark(1));
    yield* s.idle;
    expect(calls).toHaveLength(1);
    const row = diffs()[0]!;
    expect(row.error).toContain("Boom");
    expect(row.requeued).toBe(true);
    expect((yield* s.unreflectedRemarks).map((r) => r.id)).toEqual(["r1"]);

    yield* s.push(remark(2));
    yield* settle;
    expect(calls).toHaveLength(1);
    expect((yield* s.unreflectedRemarks).map((r) => r.id)).toEqual(["r1", "r2"]);

    yield* TestClock.adjust(999);
    yield* settle;
    expect(calls).toHaveLength(1);

    yield* TestClock.adjust(1);
    yield* settleUntil(() => calls.length === 2);
    expect(ids(calls[1]!)).toEqual(["r1", "r2"]);
    yield* s.idle;
    expect(yield* s.unreflectedRemarks).toEqual([]);
    expect(diffs()).toHaveLength(2);
    expect(diffs()[1]!.requeued).toBeUndefined();
    expect(diffs()[1]!.error).toBeUndefined();
  }));

  it.effect("失敗した発言は処理済みにならない: 次の呼び出しの recent に自分自身が入らず、成功するまで recent は増えない", () => Effect.gen(function* () {
    const { session: s, calls } = yield* setup(["fail"]);
    yield* s.push(remark(1));
    yield* s.idle;
    yield* TestClock.adjust(1_000);
    yield* settleUntil(() => calls.length === 2);
    yield* s.idle;
    expect(calls[1]!.recent).toEqual([]);
    yield* s.push(remark(2));
    yield* s.idle;
    expect(calls[2]!.recent.map((r) => r.id)).toEqual(["r1"]);
  }));

  it.effect("失敗が続くと、待ち時間は 1・2・4・8・10・10 秒。待ち時間の 1 ミリ秒前には呼ばず、ちょうどで呼ぶ", () => Effect.gen(function* () {
    const { session: s, calls, callTimes } = yield* setup(["fail", "fail", "fail", "fail", "fail", "fail", "fail"]);
    yield* s.push(remark(1));
    yield* s.idle;
    expect(calls).toHaveLength(1);

    for (const [i, wait] of [1_000, 2_000, 4_000, 8_000, 10_000, 10_000].entries()) {
      yield* TestClock.adjust(wait - 1);
      yield* settle;
      expect(calls, `${i + 1} 回目の失敗の ${wait - 1}ms 後`).toHaveLength(i + 1);
      yield* TestClock.adjust(1);
      yield* settleUntil(() => calls.length === i + 2);
      expect(calls, `${i + 1} 回目の失敗の ${wait}ms 後`).toHaveLength(i + 2);
      yield* s.idle;
    }
    expect(callTimes.slice(1).map((t, i) => t - callTimes[i]!)).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  }));

  it.effect("成功すると待ち時間は 1 秒に戻る（次の失敗の待ちは、増えた値ではなく 1 秒）", () => Effect.gen(function* () {
    // 1〜3 回目は失敗（待ちは 1・2・4 秒）、4 回目は成功、5 回目は失敗、6 回目は成功
    const { session: s, calls } = yield* setup(["fail", "fail", "fail", "ok", "fail", "ok"]);
    yield* s.push(remark(1));
    yield* s.idle;
    for (const wait of [1_000, 2_000, 4_000]) {
      const n = calls.length;
      yield* TestClock.adjust(wait);
      yield* settleUntil(() => calls.length === n + 1);
      yield* s.idle;
    }
    expect(calls).toHaveLength(4);
    expect(yield* s.unreflectedRemarks).toEqual([]);

    yield* s.push(remark(2));
    yield* s.idle;
    expect(calls).toHaveLength(5);
    yield* TestClock.adjust(999);
    yield* settle;
    expect(calls).toHaveLength(5);
    yield* TestClock.adjust(1);
    yield* settleUntil(() => calls.length === 6);
    expect(ids(calls[5]!)).toEqual(["r2"]);
  }));

  it.effect("時間切れも同じ待ち時間で増える: 20 秒で時間切れ → 1 秒後に再試行 → 時間切れ → 2 秒後に再試行", () => Effect.gen(function* () {
    const { session: s, calls, callTimes } = yield* setup(["hang", "hang", "ok"]);
    yield* s.push(remark(1));
    yield* settleUntil(() => calls.length === 1);
    yield* TestClock.adjust(20_000);
    yield* settle;
    expect(calls).toHaveLength(1);
    yield* TestClock.adjust(1_000);
    yield* settleUntil(() => calls.length === 2);
    yield* TestClock.adjust(20_000);
    yield* settle;
    expect(calls).toHaveLength(2);
    yield* TestClock.adjust(1_999);
    yield* settle;
    expect(calls).toHaveLength(2);
    yield* TestClock.adjust(1);
    yield* settleUntil(() => calls.length === 3);
    expect(callTimes).toEqual([0, 21_000, 43_000]);
    expect(ids(calls[2]!)).toEqual(["r1"]);
  }));

  it.effect("一時停止（利用上限）は失敗として数えない: requeued の行を書かず、待ち時間も増えず、戻った後の最初の失敗は 1 秒待つ", () => Effect.gen(function* () {
    const { session: s, calls, diffs, events } = yield* setup(["pause", "pause", "fail", "ok"]);
    yield* s.push(remark(1));
    yield* s.idle;
    expect(events.filter((e) => e.type === "diff-update-paused")).toHaveLength(1);
    expect(diffs()).toHaveLength(0);

    yield* TestClock.adjust(DIFF_UPDATE_RETRY_MS);
    yield* settleUntil(() => calls.length === 2);
    yield* s.idle;
    expect(diffs()).toHaveLength(0);
    expect(events.filter((e) => e.type === "diff-update-paused")).toHaveLength(2);

    yield* TestClock.adjust(DIFF_UPDATE_RETRY_MS);
    yield* settleUntil(() => calls.length === 3);
    yield* s.idle;
    expect(diffs()).toHaveLength(1);
    expect(diffs()[0]!.requeued).toBe(true);

    yield* TestClock.adjust(999);
    yield* settle;
    expect(calls).toHaveLength(3);
    yield* TestClock.adjust(1);
    yield* settleUntil(() => calls.length === 4);
    expect(ids(calls[3]!)).toEqual(["r1"]);
  }));

  it.effect("flush は、失敗した回の待ち時間を待たずに戻り、その後は呼び出さない。発言は pending に残る", () => Effect.gen(function* () {
    const { session: s, calls } = yield* setup(["fail", "fail", "fail"]);
    yield* s.push(remark(1));
    yield* s.idle;
    expect(calls).toHaveLength(1);

    const done = { value: false };
    yield* Effect.forkChild(s.flush.pipe(Effect.andThen(Effect.sync(() => { done.value = true; }))));
    yield* settleUntil(() => done.value);
    expect(done.value).toBe(true);
    expect(calls).toHaveLength(1);

    yield* TestClock.adjust(60_000);
    yield* settle;
    expect(calls).toHaveLength(1);
    expect((yield* s.unreflectedRemarks).map((r) => r.id)).toEqual(["r1"]);
  }));
});

// map-update-latency 5.2: 応答が返ってきたうえでの失敗が 3 回続いた頭の発言は、次の呼び出しを 1 つだけにし、それも失敗したら外す。
// 時間切れ・つながらない失敗・一時停止は数えない。外した発言は failedRemarks に持つ（取り込み待ちの通知は 6.x）
describe("同じ発言が 3 回続けて失敗したら 1 つだけで試し、それも失敗したら外す（5.2）", () => {
  // r1 を渡して最初の呼び出しを終え、待つ間に r2 を足す。以後は 1 秒ずつ時計を進めて n 回目の呼び出しまで待つ
  const start = Effect.fnUntraced(function* (steps: readonly Step[]) {
    const t = yield* setup(steps);
    yield* t.session.push(remark(1));
    // 最初の呼び出しが時間切れ（hang）の場合に備え、idle ではなく呼び出しの始まりと落ち着きを待つ
    yield* settleUntil(() => t.calls.length === 1);
    yield* settle;
    yield* t.session.push(remark(2));
    const runTo = Effect.fnUntraced(function* (n: number) {
      for (let i = 0; i < 400 && t.calls.length < n; i++) {
        yield* TestClock.adjust(1_000);
        yield* Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true });
      }
    });
    return { ...t, runTo };
  });
  const isolatedRows = (rows: readonly { isolated?: boolean }[]) => rows.filter((r) => r.isolated === true);

  it.effect("応答の失敗が 3 回続くと、4 回目の呼び出しは r1 だけ。それも失敗すると r1 を外し、待たずに r2 を呼ぶ", () => Effect.gen(function* () {
    const { session: s, calls, callTimes, diffs, runTo } = yield* start(["invalid", "invalid", "invalid", "invalid", "ok"]);
    yield* runTo(4);
    yield* s.idle;

    expect(calls.map(ids)).toEqual([["r1"], ["r1", "r2"], ["r1", "r2"], ["r1"], ["r2"]]);
    expect(callTimes[4]).toBe(callTimes[3]);
    const rows = diffs();
    expect(rows).toHaveLength(5);
    expect(rows.slice(0, 3).map((r) => [r.requeued, r.isolated])).toEqual([[true, undefined], [true, undefined], [true, undefined]]);
    expect(rows[3]!.error).toContain("DiffOutputInvalid");
    expect(rows[3]!.isolated).toBe(true);
    expect(rows[3]!.requeued).toBeUndefined();
    expect(rows[4]!.error).toBeUndefined();
    expect(rows[4]!.isolated).toBeUndefined();
    expect(yield* s.unreflectedRemarks).toEqual([]);
  }));

  it.effect("外した発言は failedRemarks に持ち、外す前は空。未反映の発言（unreflectedRemarks）には混ざらない", () => Effect.gen(function* () {
    const { session: s, calls, runTo } = yield* start(["invalid", "invalid", "invalid", "invalid", "ok"]);
    yield* runTo(3);
    yield* s.idle;
    expect(yield* s.failedRemarks).toEqual([]);

    yield* runTo(4);
    yield* s.idle;
    expect(calls).toHaveLength(5);
    expect((yield* s.failedRemarks).map((r) => r.id)).toEqual(["r1"]);
    expect(yield* s.unreflectedRemarks).toEqual([]);
  }));

  it.effect("数えるのは応答の失敗（出力が不正・結果が失敗・反映数が不正）。種類が混ざっても 3 回で 1 つだけになる", () => Effect.gen(function* () {
    const { session: s, calls, diffs, runTo } = yield* start(["invalid", "result", "badcount", "badcount", "ok"]);
    yield* runTo(4);
    yield* s.idle;
    expect(calls.map(ids)).toEqual([["r1"], ["r1", "r2"], ["r1", "r2"], ["r1"], ["r2"]]);
    expect(diffs()[3]!.isolated).toBe(true);
    expect((yield* s.failedRemarks).map((r) => r.id)).toEqual(["r1"]);
  }));

  it.effect("時間切れは数えない: 応答の失敗が 2 回でも、時間切れが挟まる限り 1 つだけにならない", () => Effect.gen(function* () {
    const { session: s, calls, diffs, runTo } = yield* start(["hang", "invalid", "hang", "invalid", "hang", "ok"]);
    yield* runTo(6);
    yield* s.idle;
    expect(calls.slice(1, 6).map(ids)).toEqual([["r1", "r2"], ["r1", "r2"], ["r1", "r2"], ["r1", "r2"], ["r1", "r2"]]);
    expect(isolatedRows(diffs())).toEqual([]);
    expect(yield* s.failedRemarks).toEqual([]);
  }));

  it.effect("つながらない失敗は数えない: 3 回以上続いても 1 つだけにならず、外さない", () => Effect.gen(function* () {
    const { session: s, calls, diffs, runTo } = yield* start(["conn", "invalid", "conn", "conn", "conn", "ok"]);
    yield* runTo(6);
    yield* s.idle;
    expect(calls.slice(1, 6).map(ids)).toEqual([["r1", "r2"], ["r1", "r2"], ["r1", "r2"], ["r1", "r2"], ["r1", "r2"]]);
    expect(isolatedRows(diffs())).toEqual([]);
    expect(yield* s.failedRemarks).toEqual([]);
  }));

  it.effect("一時停止は数えない: 応答の失敗 2 回の後に一時停止が挟まっても、戻った後の呼び出しは r1・r2 の両方", () => Effect.gen(function* () {
    const { session: s, calls, diffs, runTo } = yield* start(["invalid", "invalid", "pause", "ok"]);
    yield* runTo(3);
    yield* s.idle;
    expect(calls).toHaveLength(3);
    yield* TestClock.adjust(DIFF_UPDATE_RETRY_MS);
    yield* settleUntil(() => calls.length === 4);
    yield* s.idle;
    expect(calls.slice(2).map(ids)).toEqual([["r1", "r2"], ["r1", "r2"]]);
    expect(isolatedRows(diffs())).toEqual([]);
    expect(yield* s.failedRemarks).toEqual([]);
  }));

  it.effect("1 つだけの呼び出しが時間切れになっても外さない。r1 は戻り、次の呼び出しも r1 だけ。成功すれば r2 が進む", () => Effect.gen(function* () {
    const { session: s, calls, runTo } = yield* start(["invalid", "invalid", "invalid", "hang", "ok", "ok"]);
    yield* runTo(6);
    yield* s.idle;
    expect(calls.map(ids)).toEqual([["r1"], ["r1", "r2"], ["r1", "r2"], ["r1"], ["r1"], ["r2"]]);
    expect(yield* s.failedRemarks).toEqual([]);
    expect(yield* s.unreflectedRemarks).toEqual([]);
  }));

  it.effect("1 つだけの呼び出しがつながらずに失敗しても外さない", () => Effect.gen(function* () {
    const { session: s, calls, runTo } = yield* start(["invalid", "invalid", "invalid", "conn", "ok", "ok"]);
    yield* runTo(6);
    yield* s.idle;
    expect(calls.map(ids)).toEqual([["r1"], ["r1", "r2"], ["r1", "r2"], ["r1"], ["r1"], ["r2"]]);
    expect(yield* s.failedRemarks).toEqual([]);
  }));

  it.effect("1 つだけの呼び出しが成功すれば外さず、r1 は反映される。行には「1 つだけ」の印が付く", () => Effect.gen(function* () {
    const { session: s, calls, diffs, runTo } = yield* start(["invalid", "invalid", "invalid", "ok", "ok"]);
    yield* runTo(4);
    yield* s.idle;
    expect(calls.map(ids)).toEqual([["r1"], ["r1", "r2"], ["r1", "r2"], ["r1"], ["r2"]]);
    expect(diffs()[3]!.error).toBeUndefined();
    expect(diffs()[3]!.isolated).toBe(true);
    expect(yield* s.failedRemarks).toEqual([]);
  }));

  it.effect("一部だけ反映された成功の回は、反映されず pending に戻った発言の失敗の回数も数え直す。成功の後の失敗が 3 回に達するまで、その発言は 1 つだけにならず、外れない", () => Effect.gen(function* () {
    // r1 を外した後、[r2,r3] の呼び出しが r2 だけ反映して成功する。r3 は 2 回失敗した後に pending へ戻る。その後の失敗は 1・2 回目として数える
    const { session: s, calls, diffs, runTo } = yield* start(["invalid", "invalid", "invalid", "invalid", "partial", "invalid", "invalid"]);
    yield* s.push(remark(3));
    yield* runTo(7);
    yield* s.idle;
    expect(calls.map(ids)).toEqual([["r1"], ["r1", "r2", "r3"], ["r1", "r2", "r3"], ["r1"], ["r2", "r3"], ["r3"], ["r3"]]);
    const rows = diffs();
    expect(rows[3]!.isolated).toBe(true);
    expect(rows[5]!.requeued).toBe(true);
    expect(rows[5]!.isolated).toBeUndefined();
    expect(rows[6]!.requeued).toBe(true);
    expect(rows[6]!.isolated).toBeUndefined();
    expect((yield* s.failedRemarks).map((r) => r.id)).toEqual(["r1"]);
    expect((yield* s.unreflectedRemarks).map((r) => r.id)).toEqual(["r3"]);
  }));
});

// map-update-latency 5.3: restore は、requeued の印を持つ diff の行を「発言は 1 つも反映されていない」と読み、その発言を取り込み待ちへ戻す。
// 印の無い失敗の行（古いログ・外した回）は、今までどおり渡した発言をすべて反映済みと読む。失敗の回数は restore で 0 から数え直す
describe("restore で、戻した回の発言を取り込み待ちに戻す（5.3）", () => {
  // ファイルに書いて読み直した形（at 付き）にする
  const viaJsonl = (events: readonly LogEvent[]): unknown[] =>
    events.map((e, i) => JSON.parse(JSON.stringify({ at: `2026-10-01T00:00:0${i % 10}.000Z`, ...e })));
  const withoutRequeued = (rows: readonly unknown[]): unknown[] =>
    rows.map((row) => {
      const { requeued: _requeued, ...rest } = row as { requeued?: true };
      return rest;
    });
  const idsOf = (rs: readonly Remark[]) => rs.map((r) => r.id);
  // 復元したセッションと、そこへ渡った差分更新の呼び出し
  const restored = Effect.fnUntraced(function* (rows: readonly unknown[], update: (input: DiffInput) => Effect.Effect<{ ops: [] }, { _tag: string; message: string }> = () => Effect.succeed({ ops: [] })) {
    const calls: DiffInput[] = [];
    const session = yield* restoreSession(rows).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => { calls.push(input); return update(input); }),
      silentLog,
    )));
    return { session, calls };
  });

  it.effect("requeued の行の発言は、復元後も unreflectedRemarks に載り、known に入らず、続きの呼び出しに元の順で先頭から渡る。ライブの続きと一致する", () => Effect.gen(function* () {
    const { session: live, calls: liveCalls, events, diffs } = yield* setup(["fail"]);
    yield* live.push(remark(1));
    yield* live.idle;
    yield* live.push(remark(2));
    yield* settle;
    expect(diffs()[0]!.requeued).toBe(true);
    const rows = viaJsonl(events);

    const state = yield* restoreState(rows);
    expect(idsOf(state.pending)).toEqual(["r1", "r2"]);
    expect([...state.known]).toEqual([]);
    expect(idsOf(state.processed)).toEqual([]);

    const { session, calls } = yield* restored(rows);
    expect(idsOf(yield* session.unreflectedRemarks)).toEqual(["r1", "r2"]);
    yield* session.push(remark(3));
    yield* settleUntil(() => calls.length === 1);
    yield* session.idle;

    yield* live.push(remark(3));
    yield* TestClock.adjust(1_000);
    yield* settleUntil(() => liveCalls.length === 2);
    expect(ids(calls[0]!)).toEqual(["r1", "r2", "r3"]);
    expect(ids(calls[0]!)).toEqual(ids(liveCalls[1]!));
  }));

  it.effect("印の無い失敗の行は、古いログと同じく渡した発言をすべて反映済みと読む。requeued を外すと発言は pending に戻らず、known・processed に入る", () => Effect.gen(function* () {
    const { events } = yield* Effect.gen(function* () {
      const t = yield* setup(["fail"]);
      yield* t.session.push(remark(1));
      yield* t.session.idle;
      return t;
    });
    const rows = withoutRequeued(viaJsonl(events));
    expect(rows.some((row) => "requeued" in (row as object))).toBe(false);
    expect((rows.find((row) => (row as { type?: string }).type === "diff") as { error?: string }).error).toContain("Boom");

    const state = yield* restoreState(rows);
    expect(idsOf(state.pending)).toEqual([]);
    expect([...state.known]).toEqual(["r1"]);
    expect(idsOf(state.processed)).toEqual(["r1"]);
    const { session } = yield* restored(rows);
    expect(yield* session.unreflectedRemarks).toEqual([]);
  }));

  it.effect("1 つだけで試して外した回（isolated・requeued なし）の発言は反映済みと読む。それまでの requeued の回の発言は、外した発言以外は戻ったまま", () => Effect.gen(function* () {
    const { session: s, events, diffs, runTo } = yield* (Effect.fnUntraced(function* () {
      const t = yield* setup(["invalid", "invalid", "invalid", "invalid", "ok"]);
      yield* t.session.push(remark(1));
      yield* settleUntil(() => t.calls.length === 1);
      yield* settle;
      yield* t.session.push(remark(2));
      const runTo = Effect.fnUntraced(function* (n: number) {
        for (let i = 0; i < 400 && t.calls.length < n; i++) {
          yield* TestClock.adjust(1_000);
          yield* Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true });
        }
      });
      return { ...t, runTo };
    })());
    yield* runTo(4);
    yield* s.idle;
    expect(diffs()[3]!.isolated).toBe(true);
    expect(diffs()[3]!.requeued).toBeUndefined();

    // 外した回（4 つ目の diff の行）までのログ。r2 を呼ぶ 5 つ目の行は含めない
    const upToIsolated = events.slice(0, events.indexOf(diffs()[3]!) + 1);
    const state = yield* restoreState(viaJsonl(upToIsolated));
    expect([...state.known]).toEqual(["r1"]);
    expect(idsOf(state.processed)).toEqual(["r1"]);
    expect(idsOf(state.pending)).toEqual(["r2"]);

    const { session, calls } = yield* restored(viaJsonl(upToIsolated));
    expect(idsOf(yield* session.unreflectedRemarks)).toEqual(["r2"]);
    yield* session.push(remark(3));
    yield* settleUntil(() => calls.length === 1);
    expect(ids(calls[0]!)).toEqual(["r2", "r3"]);
  }));

  it.effect("失敗の回数は復元で 0 から数え直す: requeued の行が 3 回続いたログから復元しても、続きの呼び出しは全員を渡し、1 つだけにならない", () => Effect.gen(function* () {
    const t = yield* setup(["invalid", "invalid", "invalid"]);
    yield* t.session.push(remark(1));
    yield* settleUntil(() => t.calls.length === 1);
    yield* settle;
    yield* t.session.push(remark(2));
    for (let i = 0; i < 400 && t.calls.length < 3; i++) {
      yield* TestClock.adjust(1_000);
      yield* Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true });
    }
    yield* t.session.idle;
    expect(t.diffs().map((d) => d.requeued)).toEqual([true, true, true]);
    const rows = viaJsonl(t.events);

    const failing = () => Effect.fail({ _tag: "DiffOutputInvalid", message: "出力が不正" });
    const { session, calls } = yield* restored(rows, failing);
    yield* session.push(remark(3));
    yield* settleUntil(() => calls.length === 1);
    yield* session.idle;
    expect(ids(calls[0]!)).toEqual(["r1", "r2", "r3"]);
    // もう 1 回失敗しても、数え直しているので r1 だけの呼び出しにはならない
    yield* TestClock.adjust(1_000);
    yield* settleUntil(() => calls.length === 2);
    yield* session.idle;
    expect(ids(calls[1]!)).toEqual(["r1", "r2", "r3"]);
  }));

  it.effect("requeued の行に processedRemarks があれば、その数だけ反映済みと読み、残りは戻る。入力の発言数を超える数はログの不整合", () => Effect.gen(function* () {
    const t = yield* setup(["fail"]);
    yield* t.session.push(remark(1));
    yield* t.session.idle;
    yield* t.session.push(remark(2));
    yield* settle;
    const row = t.diffs()[0]!;
    expect(row.requeued).toBe(true);
    // 2 件を渡した回に作り替える: diff の行を末尾へ移し、fresh を 2 件にして、processedRemarks を付ける
    const rowsWith = (processedRemarks: number) => [
      ...viaJsonl(t.events.filter((e) => e !== row)),
      ...viaJsonl([{ ...row, input: { ...row.input, fresh: ["r1", "r2"] }, processedRemarks }]),
    ];

    const state = yield* restoreState(rowsWith(1));
    expect([...state.known]).toEqual(["r1"]);
    expect(idsOf(state.processed)).toEqual(["r1"]);
    expect(idsOf(state.pending)).toEqual(["r2"]);

    const error = yield* restoreState(rowsWith(3)).pipe(Effect.flip);
    expect(error).toBeInstanceOf(InvalidLogEvent);
    expect(error.reason).toContain("反映数が入力の発言数を超えています");
  }));
});
