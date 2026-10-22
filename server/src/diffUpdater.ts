// 差分更新の準備。claude.ts は Claude Agent SDK を読み込むので、使うコマンドの handler が動くときだけ開く（import も遅らせる）。
import { Effect, Layer } from "effect";
import { UpdaterUnavailable } from "./updaterUnavailable.ts";
import type { DiffUpdater } from "./core/index.ts";
import { canDisableThinking, resolveTuning, type ExecutableModel, type UpdaterTuning } from "./modelSelection.ts";

const loadClaude = Effect.fnUntraced(function* () {
  const { layerClaude, AgentSdk } = yield* Effect.tryPromise({
    try: () => import("./claude.ts"),
    catch: (e) => new UpdaterUnavailable({ message: e instanceof Error ? e.message : String(e), dependency: "claude" }),
  });
  return (model: string, tuning: UpdaterTuning) => layerClaude(model, tuning).pipe(Layer.provide(AgentSdk.layer));
});

// モデルから差分更新の Layer を作る。Layer はセッションの Scope で build する（sessionSinks.ts）。
// override は play と eval の引数だけが渡す。ライブのセッションは渡さず、モデルごとの表だけを使う。
// 渡せない組み合わせ（思考を切れるか確かめていないモデルの off）は、Claude を読み込む前に失敗にする
export const prepareUpdaterLayer = Effect.fnUntraced(function* (model: ExecutableModel, override: Partial<UpdaterTuning> = {}): Effect.fn.Return<Layer.Layer<DiffUpdater, UpdaterUnavailable>, UpdaterUnavailable> {
  const tuning = resolveTuning(model.model, override);
  if (tuning.thinking === "off" && !canDisableThinking(model.model)) {
    return yield* new UpdaterUnavailable({ message: `モデル ${model.model} では思考を切る設定（thinking: off）を渡せるか確かめていません` });
  }
  return (yield* loadClaude())(model.model, tuning);
});
