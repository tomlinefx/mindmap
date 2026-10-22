// 差分更新のモデル（CONTEXT.md）。初版は Claude だけで、名前は Agent SDK に渡すモデルの id（ADR 0002）。
// セッションの開始時に決め、途中では変えない。
import { Schema } from "effect";

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";

// CLI が決めて本文で渡し、server はそのまま受ける。local は常に false（会議の中身は Claude に出る）
export const ExecutableModel = Schema.Struct({
  name: Schema.Literal("claude"),
  route: Schema.Literal("claude"),
  model: Schema.NonEmptyString,
  local: Schema.Literal(false),
});
export type ExecutableModel = typeof ExecutableModel["Type"];

export const claudeModel = (model: string = DEFAULT_CLAUDE_MODEL): ExecutableModel => ({ name: "claude", route: "claude", model, local: false });
export const defaultClaude: ExecutableModel = claudeModel();

// 差分更新の思考と effort（タスク 8.1）。モデルごとの既定は表に持ち、play と eval だけが引数で上書きできる。ライブのセッションは表だけを使う。
export type ThinkingSetting = "adaptive" | "off";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type UpdaterTuning = { readonly effort: EffortLevel; readonly thinking: ThinkingSetting };

const BASE_TUNING: UpdaterTuning = { effort: "medium", thinking: "adaptive" };

// off を渡せるモデル。claude-sonnet-5-5 は 1.1 で disabled が通ることを確かめた。haiku は未確認のまま通す（8.4 の評価で確かめる）。表に無いモデルは渡せるか分からないので拒む
const THINKING_OFF_MODELS: readonly string[] = [DEFAULT_CLAUDE_MODEL, "claude-haiku-5-5"];

const TUNING_BY_MODEL: ReadonlyMap<string, UpdaterTuning> = new Map<string, UpdaterTuning>([
  [DEFAULT_CLAUDE_MODEL, BASE_TUNING],
  ["claude-haiku-5-5", { effort: "low", thinking: "adaptive" }],
]);

export const defaultTuning = (model: string): UpdaterTuning => TUNING_BY_MODEL.get(model) ?? BASE_TUNING;

// 上書きで渡した項目だけを替える。渡せるかどうかはここでは見ない（canDisableThinking）
export const resolveTuning = (model: string, override: Partial<UpdaterTuning>): UpdaterTuning => ({
  effort: override.effort ?? defaultTuning(model).effort,
  thinking: override.thinking ?? defaultTuning(model).thinking,
});

export const canDisableThinking = (model: string): boolean => THINKING_OFF_MODELS.includes(model);
