// 差分更新の準備。claude.ts は Claude Agent SDK を読み込むので、使うコマンドの handler が動くときだけ開く（import も遅らせる）。
import { Effect, Layer } from "effect";
import { UpdaterUnavailable } from "./updaterUnavailable.ts";
import type { DiffUpdater } from "./core/index.ts";
import type { ExecutableModel } from "./modelSelection.ts";

const loadClaude = Effect.fnUntraced(function* () {
  const { layerClaude, AgentSdk } = yield* Effect.tryPromise({
    try: () => import("./claude.ts"),
    catch: (e) => new UpdaterUnavailable({ message: e instanceof Error ? e.message : String(e), dependency: "claude" }),
  });
  return (model: string) => layerClaude(model).pipe(Layer.provide(AgentSdk.layer));
});

// モデルから差分更新の Layer を作る。Layer はセッションの Scope で build する（sessionSinks.ts）
export const prepareUpdaterLayer = Effect.fnUntraced(function* (model: ExecutableModel): Effect.fn.Return<Layer.Layer<DiffUpdater, UpdaterUnavailable>, UpdaterUnavailable> {
  return (yield* loadClaude())(model.model);
});
