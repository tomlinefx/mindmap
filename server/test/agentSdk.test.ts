import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { vi } from "vitest";
import { AgentSdk, layerClaude } from "../src/claude.ts";
import { DiffUpdater, emptyMap } from "../src/core/index.ts";

// 本物の Claude を呼ばない。AgentSdk.layer は通常の依存の SDK の query をそのまま使う（ADR 0002）ので、SDK のモジュールを偽物にする
const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (...args: unknown[]) => sdk.query(...args) }));

describe("通常の依存の SDK を使う AgentSdk", () => {
  it.effect("SDK の query で差分更新する", () => Effect.gen(function* () {
    sdk.query.mockImplementation(() => Object.assign((async function* () {
      yield { type: "result", subtype: "success", structured_output: { ops: [{ op: "noop", reason: "SDK の応答" }] } };
    })(), { close: () => {} }));
    yield* Effect.gen(function* () {
      const updater = yield* DiffUpdater;
      const result = yield* updater.update({ map: emptyMap("定例"), recent: [], fresh: [{ id: "r1", track: "相手", start: 0, end: 1, text: "合成の発言" }] });
      expect(result.ops).toEqual([{ op: "noop", reason: "SDK の応答" }]);
      expect(sdk.query).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layerClaude("synthetic-model").pipe(Layer.provide(AgentSdk.layer))));
  }).pipe(Effect.scoped));
});
