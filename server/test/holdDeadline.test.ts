import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import { TestClock } from "effect/testing";
import type { SettledRemark, SpeakerLogEvent } from "../src/core/index.ts";
import { createRemarkSettling } from "../src/remarkSettling.ts";

// 相手の発言が話者のラベルを待つ保留は、音声の終わりから壁時計で 2 秒を超えない（map-update-latency 4.2）。
// 期限 = 原点の壁時計 + 発言の end(秒)*1000 + 2000。壁時計が無いときは、保留に入った時刻 + 2000。
// 期限の fiber はセッションの Scope が持ち、止めれば何も出ない。時計は TestClock（開始 0）だけで進める。

const HOLD_MS = 2000;
const final = (start: number, end: number, text: string): SettledRemark => ({ track: "相手", start, end, text });
const settledTo = (to: number): SpeakerLogEvent => ({ type: "speaker-settled", track: "相手", to });
const texts = (emitted: SettledRemark[]) => emitted.map((r) => r.text);

// speakerOff: false のまま（ラベルを待つ保留に入る）。originWall は呼び出しごとに読まれる Effect
const setup = Effect.fn("setup")(function* (originWall: number | undefined) {
  const emitted: SettledRemark[] = [];
  const scope = yield* Effect.acquireRelease(Scope.make(), (made) => Scope.close(made, Exit.void));
  const settling = yield* createRemarkSettling({
    emit: (r) => Effect.sync(() => emitted.push(r)),
    holdDeadline: { scope, originWall: Effect.succeed(originWall) },
  });
  return { settling, emitted, scope };
});

describe("保留の期限（原点の壁時計 + end + 2 秒）", () => {
  it.effect("壁時計があるとき、音声の終わりから 2 秒後の 1 ミリ秒前までは出ず、2 秒後に話者なしで 1 件だけ出る", () =>
    Effect.gen(function* () {
      const wall = 1000;
      const { settling, emitted } = yield* setup(wall);

      yield* settling.final(final(10, 12, "あい。"));
      expect(emitted).toEqual([]);

      yield* TestClock.adjust(wall + 12 * 1000 + HOLD_MS - 1);
      expect(emitted).toEqual([]);
      yield* TestClock.adjust(1);
      expect(emitted).toEqual([{ track: "相手", start: 10, end: 12, text: "あい。" }]);

      yield* TestClock.adjust(HOLD_MS * 10);
      expect(emitted).toHaveLength(1); // 期限は 1 回だけ
    }));

  it.effect("保留に入ったときがもう期限を過ぎていれば、待たずに出る", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup(-100_000); // 音声の終わり（壁時計では -88000）から 2 秒はとうに過ぎている

      yield* settling.final(final(10, 12, "あい。"));
      yield* TestClock.adjust(0);

      expect(texts(emitted)).toEqual(["あい。"]);
    }));

  it.effect("壁時計が無いとき、保留に入った時刻から 2 秒後に出る（end が大きくても end は使わない）", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup(undefined);

      yield* TestClock.adjust(5000); // 保留に入るのは時計 5000 のとき
      yield* settling.final(final(98, 100, "あい。"));

      yield* TestClock.adjust(HOLD_MS - 1);
      expect(emitted).toEqual([]);
      yield* TestClock.adjust(1);
      expect(texts(emitted)).toEqual(["あい。"]);
    }));

  it.effect("話者が先に揃った発言は話者付きで 1 件だけ出て、期限が来ても二重に出ない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup(0);

      yield* settling.final(final(10, 12, "あい。"));
      yield* settling.speaker({ type: "speaker", track: "相手", start: 10, end: 12, slot: 0, final: true });
      yield* settling.speaker(settledTo(12));
      expect(emitted.map((r) => [r.speaker, r.text])).toEqual([["相手 A", "あい。"]]);

      yield* TestClock.adjust(12 * 1000 + HOLD_MS * 10);
      expect(emitted.map((r) => [r.speaker, r.text])).toEqual([["相手 A", "あい。"]]);
    }));

  it.effect("保留が 2 件あるとき、それぞれの期限で順に出て、後の期限が先の発言を二重に出さない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup(0);

      yield* settling.final(final(10, 12, "ひとつめ"));
      yield* settling.final(final(13, 15, "ふたつめ"));

      yield* TestClock.adjust(12 * 1000 + HOLD_MS);
      expect(texts(emitted)).toEqual(["ひとつめ"]);
      yield* TestClock.adjust(3 * 1000 - 1);
      expect(texts(emitted)).toEqual(["ひとつめ"]);
      yield* TestClock.adjust(1);
      expect(texts(emitted)).toEqual(["ひとつめ", "ふたつめ"]);

      yield* TestClock.adjust(HOLD_MS * 10);
      expect(texts(emitted)).toEqual(["ひとつめ", "ふたつめ"]);
    }));

  it.effect("speaker-off で先に出た発言は、期限が来ても二重に出ない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup(0);

      yield* settling.final(final(10, 12, "あい。"));
      yield* settling.speaker({ type: "speaker-off", start: 0, reason: "モデルなし" });
      expect(texts(emitted)).toEqual(["あい。"]);

      yield* TestClock.adjust(12 * 1000 + HOLD_MS * 10);
      expect(texts(emitted)).toEqual(["あい。"]);
    }));
});

describe("期限の fiber はセッションの Scope が持つ", () => {
  it.effect("settling.stop の後は、期限が来ても何も出ない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup(0);

      yield* settling.final(final(10, 12, "あい。"));
      yield* settling.stop;
      yield* TestClock.adjust(12 * 1000 + HOLD_MS * 10);

      expect(emitted).toEqual([]);
    }));

  it.effect("Scope を閉じた後は、期限が来ても何も出ない", () =>
    Effect.gen(function* () {
      const { settling, emitted, scope } = yield* setup(0);

      yield* settling.final(final(10, 12, "あい。"));
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust(12 * 1000 + HOLD_MS * 10);

      expect(emitted).toEqual([]);
    }));
});
