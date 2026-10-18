// 開始前の確かめ（CONTEXT.md）。セッションに要るものは、ヘルパーの実行ファイル・マイクの許可・端末内 STT のモデルで、
// ヘルパーの `check` の結果から項目にする。欠けると始められないものが足りなければ StartupDepsMissing で始めない（exit 3）。
// 足りないものを入れるのは利用者が確かめてから明示で行い、確かめの中では入れない。
import { Effect, Schema } from "effect";
import { HELPER_BUILD_COMMAND, INSTALLED_HELPER_DIR_NAME } from "./helperPath.ts";
import type { HelperCheck, HelperCheckFailure } from "./helpers.ts";

export const Item = Schema.Struct({
  name: Schema.Literals(["helper", "microphone", "stt-model"]),
  // ready: そろっている。missing: 無い。denied: 許可が無い。undetermined: まだ聞いていない（ヘルパーの起動で聞く）
  state: Schema.Literals(["ready", "missing", "denied", "undetermined"]),
});
export type Item = typeof Item["Type"];

// GET /check の応答（cli check が読む）
export const CheckReport = Schema.Struct({ items: Schema.Array(Item) });
export type CheckReport = typeof CheckReport["Type"];

const descriptions: Record<Item["name"], string> = { helper: "ヘルパーの実行ファイル", microphone: "マイクの許可", "stt-model": "日本語の音声認識モデル" };

export const describeItem = (item: Item): string => `${item.name}（${descriptions[item.name]}）`;

export class StartupDepsMissing extends Schema.TaggedError<StartupDepsMissing>()("StartupDepsMissing", {
  items: Schema.Array(Item),
}) {
  override get message(): string {
    const names = new Set(this.items.map((item) => item.name));
    return [
      `開始しません。足りないもの: ${this.items.map(describeItem).join("、")}`,
      ...(names.has("helper") ? [`ヘルパーを用意するには: ${HELPER_BUILD_COMMAND}（または GitHub Releases の mindmap-helper-win-x64 の zip を ${INSTALLED_HELPER_DIR_NAME} に展開）`] : []),
      ...(names.has("microphone") ? ["Windows の 設定 > プライバシーとセキュリティ > マイク で、デスクトップ アプリにマイクの使用を許可してください"] : []),
      ...(names.has("stt-model") ? ["音声認識のモデルを入れてください（helper/README.md）"] : []),
      "利用者に確認してから入れてください",
    ].join("\n");
  }
}

// ヘルパーの check の結果を項目にする。マイクの undetermined は、ヘルパーの起動で許可を聞くので足りないとは数えない
export const checkItems = (check: HelperCheck): Item[] => [
  { name: "microphone", state: check.microphone === "authorized" ? "ready" : check.microphone === "denied" ? "denied" : "undetermined" },
  { name: "stt-model", state: check.sttModel === "installed" ? "ready" : "missing" },
];

// check が動かない（ヘルパーが起動できない・出力が読めない）ときは、ヘルパーそのものが欠けている扱い
export const checkReport = (check: Effect.Effect<HelperCheck, HelperCheckFailure>): Effect.Effect<CheckReport> =>
  check.pipe(
    Effect.map((result): CheckReport => ({ items: checkItems(result) })),
    Effect.catchTag("HelperCheckFailure", () => Effect.succeed<CheckReport>({ items: [{ name: "helper", state: "missing" }] })),
  );

export const isMissing = (item: Item): boolean => item.state === "missing" || item.state === "denied";

// 開始前の確かめ。足りなければ StartupDepsMissing
export const requireStartup = (check: Effect.Effect<HelperCheck, HelperCheckFailure>): Effect.Effect<CheckReport, StartupDepsMissing> =>
  Effect.flatMap(checkReport(check), (report) => {
    const missing = report.items.filter(isMissing);
    return missing.length > 0 ? Effect.fail(new StartupDepsMissing({ items: missing })) : Effect.succeed(report);
  });
