import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { LogEvent, makeSession, type DiffInput, type Remark, type Session } from "../src/core/index.ts";
import { collectLog, updaterLayer } from "./fixtures/sessionLayers.ts";

const remark = (n: number): Remark => ({ id: `r${n}`, track: "相手", start: n, end: n + 1, text: `発言${n}。` });
const ids = (remarks: readonly Remark[]) => remarks.map((r) => r.id);
// 発言 1 件を push して、その呼び出しが終わるまで待つ（差分更新は呼び出し中でなければ発言 1 件ですぐ呼ばれる）
const pushOne = Effect.fnUntraced(function* (session: Session, n: number) {
  yield* session.push(remark(n));
  yield* session.idle;
});

describe("同じ Session の差分更新停止", () => {
  it.effect("停止タグの後は新着・時間経過・flushで更新せず、既存マップと新着の記録を保持する", () => Effect.gen(function* () {
    const calls: DiffInput[] = [];
    const events: LogEvent[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.suspend(() => {
        calls.push(input);
        return calls.length === 1 ? Effect.succeed({ ops: [{ op: "add", ref: "topic", parent: "root", kind: "議題", text: "採用", evidence: ids(input.fresh) }] })
          : Effect.fail({ _tag: "DiffUpdateStopped", message: "合成の再起動上限" });
      })), collectLog(events),
    )));
    yield* pushOne(session, 1);
    const before = yield* session.snapshot;
    const beforeExport = yield* session.exportJson;
    expect(before.nodes.map((n) => n.text)).toContain("採用");
    yield* pushOne(session, 2);
    expect(yield* session.diffUpdate).toEqual({ status: "stopped" });
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r2"]);
    yield* session.push(remark(3));
    yield* session.push(remark(4));
    yield* TestClock.adjust(3_600_000);
    yield* session.idle;
    yield* session.push(remark(5));
    yield* session.push(remark(6));
    yield* session.flush;
    expect(calls).toHaveLength(2);
    expect((yield* session.snapshot).nodes).toEqual(before.nodes);
    expect((yield* session.snapshot).changes).toEqual(before.changes);
    expect(yield* session.exportJson).toEqual(beforeExport);
    expect(events.filter((e) => e.type === "remark").map((e) => e.remark.id)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r2", "r3", "r4", "r5", "r6"]);
  }));
});
