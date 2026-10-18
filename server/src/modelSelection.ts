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
