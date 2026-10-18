// 入口のテストが共有する補助。一時フォルダと、Console を差し替えて stdout・stderr を集める Layer
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";

export const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-test-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
);

// Console.log に渡された引数を、末尾の改行込みの 1 行として stdout に集める（本物の Console.log と同じ区切り）
export function consoleCapture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const service: Console.Console = {
    ...console,
    log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); },
    error: (...args: unknown[]) => { stderr.push(args.map(String).join(" ") + "\n"); },
  };
  return { layer: Layer.mergeAll(NodeServices.layer, Layer.succeed(Console.Console, service)), stdout, stderr };
}
