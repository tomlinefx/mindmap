// 話者のラベルを待つ保留の期限（map-update-latency 4.2）。保留に入った発言は、音声の終わりから壁時計で 2 秒を超えて待たせない。
// 予約は Effect の Clock と Effect.sleep のファイバーで張る（中核は実行環境のタイマーを使わない。ADR 0003）。
import { Clock, Effect, Scope } from "effect";
import type { SettledRemark } from "./core/index.ts";

export const HOLD_LIMIT_MS = 2000;

export type HoldDeadlineOptions = {
  // 期限のファイバーを持つ Scope（セッションの Scope。閉じたら止まる）
  scope: Scope.Scope;
  // 原点の壁時計（ms）。ヘルパーが知らせるまでは undefined
  originWall: Effect.Effect<number | undefined>;
  release: (remark: SettledRemark) => Effect.Effect<void>;
};

export const createHoldDeadline = ({ scope, originWall, release }: HoldDeadlineOptions) => ({
  // 壁時計が無いときは、音声の時刻を壁時計に直せないので、保留に入った時刻から数える
  arm: Effect.fnUntraced(function* (remark: SettledRemark) {
    const now = yield* Clock.currentTimeMillis;
    const wall = yield* originWall;
    const expiry = (wall === undefined ? now : wall + remark.end * 1000) + HOLD_LIMIT_MS;
    yield* Effect.forkIn(Effect.andThen(Effect.sleep(Math.max(0, expiry - now)), release(remark)), scope);
  }),
});
