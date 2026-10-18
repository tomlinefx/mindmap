// 閲覧の共有（ADR 0003）。閲覧の口（LAN に向けた別の待受け）を開き、状態を持つ。
// 共有の Scope は、いま live なセッションの Scope の子にする。閉じる経路（close・セッションの終了・server の終了）は
// どれも、この Scope の後始末（閲覧の口の待受けを閉じる・状態を無しに戻す）に合流する。
// http.ts を import しない（循環を避ける）。閲覧の口を開く関数は Layer の引数で受ける。
import { randomInt } from "node:crypto";
import { networkInterfaces } from "node:os";
import { Context, Effect, Exit, Layer, Ref, Schema, Scope, Semaphore } from "effect";
import { viewingUrls, type OpenShareStatus, type ShareStatus } from "./core/index.ts";
import { ReviewBuild } from "./review.ts";
import type { SessionFailure } from "./sessionFailure.ts";
import { Sessions } from "./sessions.ts";
import { Viewers } from "./viewers.ts";

// 閲覧の共有を開けなかった（画面のビルド・待受けの失敗）。message は原因の文面
export class ShareOpenFailed extends Schema.TaggedError<ShareOpenFailed>()("ShareOpenFailed", { message: Schema.String }) {}

// 閲覧の口を開く。PIN を受け、待ち受けているポートを返す。待受けは呼び出し側の Scope で閉じる
export type OpenViewingPort = (pin: string) => Effect.Effect<number, { readonly message: string }, Viewers | ReviewBuild | Scope.Scope>;

export type ViewingShareOptions = {
  readonly openViewingPort: OpenViewingPort;
  readonly addresses: () => readonly string[]; // 閲覧の URL に使うこの機械のアドレス
};

// この機械の LAN のアドレス（IPv4、loopback 以外。Tailscale のアドレスも含む）
export const lanAddresses = (): string[] =>
  Object.values(networkInterfaces()).flatMap((list) => (list ?? []).filter((i) => i.family === "IPv4" && !i.internal).map((i) => i.address));

export const makePin = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");

type Current = { readonly scope: Scope.Closeable; readonly status: OpenShareStatus };

export class ViewingShare extends Context.Service<ViewingShare, {
  // 閲覧の共有を開く。すでに開いていれば今の状態を返し、新しくは開かない
  open: Effect.Effect<OpenShareStatus, ShareOpenFailed | SessionFailure>;
  // 閉じる。開いていなくても成功する
  close: Effect.Effect<void>;
  status: Effect.Effect<ShareStatus>;
}>()("live-mindmap/server/ViewingShare") {
  static readonly layer = (options: ViewingShareOptions): Layer.Layer<ViewingShare, never, Sessions | Viewers | ReviewBuild> =>
    Layer.effect(ViewingShare)(Effect.gen(function* () {
      const sessions = yield* Sessions;
      const viewers = yield* Viewers;
      const build = yield* ReviewBuild;
      const current = yield* Ref.make<Current | undefined>(undefined);
      // 開く・閉じるは 1 つずつ。二重に開かず、開く途中で閉じる操作と交わらない
      const lock = yield* Semaphore.make(1);

      const open = lock.withPermits(1)(Effect.gen(function* () {
        const existing = yield* Ref.get(current);
        if (existing !== undefined) return existing.status;
        const { scope: sessionScope } = yield* sessions.liveSession;
        const scope = yield* Scope.fork(sessionScope, "sequential");
        const pin = makePin();
        const port = yield* options.openViewingPort(pin).pipe(
          Effect.provideService(Viewers, viewers),
          Effect.provideService(ReviewBuild, build),
          Scope.provide(scope),
          Effect.mapError((error) => new ShareOpenFailed({ message: error.message })),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
        const status: OpenShareStatus = { status: "open", urls: viewingUrls(options.addresses(), port, pin), pin };
        // 状態の登録を後始末の登録より先に置く（閉じた Scope では後始末がその場で走り、登録した状態を消す）
        yield* Ref.set(current, { scope, status });
        // 共有の Scope が閉じたら（どの経路でも）、同じ共有のときだけ状態を無しに戻す
        yield* Scope.addFinalizer(scope, Ref.update(current, (now) => (now?.scope === scope ? undefined : now)));
        return status;
      }));

      const close = lock.withPermits(1)(Effect.gen(function* () {
        const existing = yield* Ref.get(current);
        if (existing !== undefined) yield* Scope.close(existing.scope, Exit.void);
      }));

      const status = Effect.map(Ref.get(current), (now): ShareStatus => now?.status ?? { status: "off" });

      return ViewingShare.of({ open, close, status });
    }));
}
