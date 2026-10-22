// 途中結果から発言を出す規則（core/settle.ts）を、停止の門につなぐ。
// 時計は届いた結果の end の最大値（音声の時刻）だけ。壁時計では進めない（結果が届かない間は発言を出さない。出すのは、結果の到着・確定結果・drain のとき）。
// settler の戻り値（4 つの出口は、どれもここを通る）の後ろに、話者を決める段（core/speakers.ts）を 1 段だけ置く（Issue #1021）。
// 相手の発言は、確定した話者の区間が揃うまで保留される（最大 SPEAKER_WAIT_MS）。段の状態（枠とラベルの対応）は、この settling と同じ寿命で 1 つ
import { Effect, Scope, Semaphore } from "effect";
import { createRemarkSettler, createSpeakerAttribution, type HelperPartial, type SettledRemark, type SpeakerAttributionOptions, type SpeakerLogEvent } from "./core/index.ts";
import { createHoldDeadline } from "./holdDeadline.ts";
import { createStopGate } from "./stopGate.ts";

export type RemarkSettlingOptions = {
  emit: (remark: SettledRemark) => Effect.Effect<void>;
  // 話者の段の規則の切り替えと判定の記録（Issue #1030）。ライブは渡さない
  speakers?: SpeakerAttributionOptions;
  // 保留の期限（map-update-latency 4.2）。渡すと、保留に入った発言ごとに壁時計の期限を張る。ライブだけが渡す
  holdDeadline?: { scope: Scope.Scope; originWall: Effect.Effect<number | undefined> };
  // 保留の入りと出（map-update-latency 6.2）。どの出口も、emit が済んだ後にロックを握ったまま呼ぶ
  onHeldChange?: Effect.Effect<void>;
};

export const createRemarkSettling = Effect.fnUntraced(function* ({ emit, speakers, holdDeadline, onHeldChange }: RemarkSettlingOptions) {
  const settler = createRemarkSettler();
  const attribution = createSpeakerAttribution(speakers);
  const gate = yield* createStopGate;
  const { unlessStopped } = gate;

  const emitAll = (remarks: readonly SettledRemark[]) => Effect.forEach(remarks, emit, { discard: true });

  // 期限のファイバーは 2 本目の発言の出口になる。発言の id は emit の中で振られて順に push されるので、出口を 1 本ずつに直列にする
  const lock = yield* Semaphore.make(1);
  const serialized = (effect: Effect.Effect<void>) => unlessStopped(lock.withPermit(onHeldChange === undefined ? effect : Effect.andThen(effect, onHeldChange)));

  const deadline = holdDeadline === undefined ? undefined : createHoldDeadline({
    ...holdDeadline,
    release: (remark) => serialized(Effect.suspend(() => emitAll(attribution.releaseThrough(remark)))),
  });
  // 保留に入った発言を、入った時点で 1 回だけ期限に載せる。発言を出す前に張るので、push が遅くても期限の起点は遅れない
  const armed = new WeakSet<SettledRemark>();
  const armHeld = deadline === undefined ? Effect.void : Effect.suspend(() =>
    Effect.forEach(attribution.heldRemarks().filter((remark) => !armed.has(remark)), (remark) => {
      armed.add(remark);
      return deadline.arm(remark);
    }, { discard: true }));
  const withHold = (remarks: SettledRemark[]) => Effect.andThen(armHeld, emitAll(remarks));

  return {
    partial: (p: HelperPartial) => serialized(Effect.suspend(() => withHold(attribution.remarks(settler.partial(p), p.end * 1000)))),
    final: (r: SettledRemark) => serialized(Effect.suspend(() => withHold(attribution.remarks(settler.final(r), r.end * 1000)))),
    // ヘルパーの speaker / speaker-off。揃った保留と、speaker-off で待たなくなった保留を出す
    speaker: (event: SpeakerLogEvent) => serialized(Effect.suspend(() => emitAll(attribution.speaker(event)))),
    // ヘルパーを起動し直した（Issue #1025）。前の世代の保留を出し切り、枠単位の状態を捨てる
    renumbered: serialized(Effect.suspend(() => emitAll(attribution.restart()))),
    // 停止時。まだ出ていない発話と保留を T・3 秒を待たずにすべて出す（揃っていない保留は話者なし）
    drain: serialized(Effect.suspend(() => emitAll([...attribution.remarks(settler.drain(), 0), ...attribution.drain()]))),
    // 字幕のための読み取り（Issue #1022）。発言の判定には使わない
    preview: {
      // 途中結果のうち、もう発言になった分を除いた後ろ（Issue #1222）。発言を出すときと同じ規則で切る
      unemittedTail: settler.unemittedTail,
      heldRemarks: attribution.heldRemarks,
      segments: attribution.previewSegments,
      label: attribution.previewLabel,
    },
    // 発言に振ったラベル。名前を付けられるのはこれだけ（Issue #1026）
    labels: attribution.labels,
    // 以後の入力は無視する
    stop: gate.stop,
  };
});
