import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import { prepareUpdaterLayer } from "../src/diffUpdater.ts";
import { DiffUpdater, emptyMap } from "../src/core/index.ts";
import { defaultClaude } from "../src/modelSelection.ts";

// 本物の Claude を呼ばない。SDK のモジュールを偽物にする
const sdk = vi.hoisted(() => ({ query: vi.fn(), close: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (...args: unknown[]) => sdk.query(...args) }));

effectIt.effect("Claude の準備は SDK を呼ばず、更新の query を消費側の Scope で閉じる", () => Effect.gen(function* () {
  sdk.query.mockImplementation(() => Object.assign((async function* () {
    yield { type: "result", subtype: "success", structured_output: { ops: [{ op: "noop", reason: "SDK の応答" }] } };
  })(), { close: sdk.close }));
  const layer = yield* prepareUpdaterLayer(defaultClaude);
  expect(sdk.query).not.toHaveBeenCalled();
  yield* Effect.gen(function* () {
    const updater = yield* DiffUpdater;
    const result = yield* updater.update({ map: emptyMap("定例"), recent: [],
      fresh: [{ id: "r1", track: "相手", start: 0, end: 1, text: "合成の発言" }],
    });
    expect(result.ops).toEqual([{ op: "noop", reason: "SDK の応答" }]);
    expect(sdk.query).toHaveBeenCalledOnce();
    expect(sdk.close).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer));
  expect(sdk.close).toHaveBeenCalledOnce();
}));
