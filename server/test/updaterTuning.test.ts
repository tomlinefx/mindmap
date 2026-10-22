// 差分更新の思考と effort の表（タスク 8.1）。表の既定・上書き・渡せない組み合わせの失敗を、prepareUpdaterLayer の入口から確かめる。
import { it as effectIt } from "@effect/vitest";
import { Effect, type Layer } from "effect";
import { describe, expect, vi } from "vitest";
import { prepareUpdaterLayer } from "../src/diffUpdater.ts";
import { DiffUpdater, emptyMap } from "../src/core/index.ts";
import { claudeModel, defaultClaude, defaultTuning, resolveTuning } from "../src/modelSelection.ts";

// 本物の Claude を呼ばない。SDK のモジュールを偽物にする
const sdk = vi.hoisted(() => ({ query: vi.fn(), close: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (...args: unknown[]) => sdk.query(...args) }));

const HAIKU = "claude-haiku-5-5";

describe("既定の表", () => {
  effectIt.effect("sonnet は medium + adaptive、haiku は low + adaptive、表に無いモデルは medium + adaptive", () => Effect.sync(() => {
    expect(defaultTuning(defaultClaude.model)).toEqual({ effort: "medium", thinking: "adaptive" });
    expect(defaultTuning(HAIKU)).toEqual({ effort: "low", thinking: "adaptive" });
    expect(defaultTuning("unknown-model")).toEqual({ effort: "medium", thinking: "adaptive" });
  }));

  effectIt.effect("上書きなしは既定のまま。渡した項目だけが替わり、渡さない項目は表の値のまま", () => Effect.sync(() => {
    expect(resolveTuning(HAIKU, {})).toEqual(defaultTuning(HAIKU));
    expect(resolveTuning(HAIKU, { effort: "high" })).toEqual({ effort: "high", thinking: "adaptive" });
    expect(resolveTuning(defaultClaude.model, { thinking: "off" })).toEqual({ effort: "medium", thinking: "off" });
    expect(resolveTuning(defaultClaude.model, { effort: "xhigh", thinking: "off" })).toEqual({ effort: "xhigh", thinking: "off" });
  }));
});

// Layer を build して 1 回更新し、query() に渡った options を返す
const optionsOf = (layer: Layer.Layer<DiffUpdater, unknown>) => Effect.gen(function* () {
  sdk.query.mockClear();
  sdk.query.mockImplementation(() => Object.assign((async function* () {
    yield { type: "result", subtype: "success", structured_output: { ops: [{ op: "noop", reason: "SDK の応答" }] } };
  })(), { close: sdk.close }));
  yield* Effect.gen(function* () {
    const updater = yield* DiffUpdater;
    yield* updater.update({ map: emptyMap("定例"), recent: [], fresh: [{ id: "r1", track: "相手", start: 0, end: 1, text: "合成の発言" }] });
  }).pipe(Effect.provide(layer));
  return sdk.query.mock.calls[0]![0].options as { effort?: string; thinking?: unknown };
});

describe("prepareUpdaterLayer の上書き", () => {
  effectIt.effect("上書きなしでは、今と同じ options（表の effort、thinking のキー無し）で query が呼ばれる", () => Effect.gen(function* () {
    const options = yield* optionsOf(yield* prepareUpdaterLayer(defaultClaude));

    expect(options.effort).toBe("medium");
    expect("thinking" in options).toBe(false);
  }));

  effectIt.effect("thinking: off は { type: disabled } として、effort の上書きは effort として query に届く", () => Effect.gen(function* () {
    const options = yield* optionsOf(yield* prepareUpdaterLayer(defaultClaude, { thinking: "off", effort: "high" }));

    expect(options.effort).toBe("high");
    expect(options.thinking).toEqual({ type: "disabled" });
  }));

  effectIt.effect("haiku の thinking: off は確かめていないまま通り、表の effort（low）と { type: disabled } が query に届く", () => Effect.gen(function* () {
    const options = yield* optionsOf(yield* prepareUpdaterLayer(claudeModel(HAIKU), { thinking: "off" }));

    expect(options.effort).toBe("low");
    expect(options.thinking).toEqual({ type: "disabled" });
  }));

  effectIt.effect("thinking: adaptive を明示しても、上書きなしと同じ（thinking のキー無し）", () => Effect.gen(function* () {
    const options = yield* optionsOf(yield* prepareUpdaterLayer(defaultClaude, { thinking: "adaptive" }));

    expect("thinking" in options).toBe(false);
  }));
});

describe("渡せない組み合わせは始める前に失敗する", () => {
  effectIt.effect("表に無い（確かめていない）モデルの thinking: off は UpdaterUnavailable で、モデル名を示し、SDK を呼ばない", () => Effect.gen(function* () {
    sdk.query.mockClear();
    const failure = yield* Effect.flip(prepareUpdaterLayer(claudeModel("unknown-model"), { thinking: "off" }));

    expect(failure._tag).toBe("UpdaterUnavailable");
    expect(failure.message).toContain("unknown-model");
    expect(sdk.query).not.toHaveBeenCalled();
  }));

  effectIt.effect("同じモデルでも thinking が adaptive なら失敗しない（黙って adaptive にして通すのではなく、off だけを拒む）", () => Effect.gen(function* () {
    const options = yield* optionsOf(yield* prepareUpdaterLayer(claudeModel("unknown-model"), { effort: "high" }));

    expect(options.effort).toBe("high");
    expect("thinking" in options).toBe(false);
  }));
});
