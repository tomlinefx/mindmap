import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Console, Effect, Layer } from "effect";
import { beforeEach, vi } from "vitest";
import { runCli } from "../src/cli.ts";
import { ReviewBuild } from "../src/review.ts";
import { fakeListener } from "./fakeListener.ts";

// play <セッションのフォルダ> を、CLI の入口から偽の Agent SDK の query まで通して確かめる（試すシームは CLI の play + 偽の query）。
// 本物の layerClaude を残し、AgentSdk.layer だけを偽物に替える。

type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };
type SentMessage = { type: string; message: { role: string; content: string | Block[] } };
type Created = { messages: SentMessage[]; options: { systemPrompt: string } };

const external = vi.hoisted(() => ({
  created: [] as Created[],
  openListener: vi.fn(),
}));

vi.mock("../src/claude.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/claude.ts")>();
  const { Layer: L } = await import("effect");
  // prompt から user メッセージを 1 つ読むたびに、noop の結果を 1 つ返す
  const query = ((params: { prompt: AsyncIterable<SentMessage>; options: Created["options"] }) => {
    const record: Created = { messages: [], options: params.options };
    external.created.push(record);
    const gen = (async function* () {
      for await (const message of params.prompt) {
        record.messages.push(message);
        yield { type: "assistant", message: { model: "fake-model", usage: { input_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens: 0 } } };
        yield { type: "result", subtype: "success", structured_output: { ops: [{ op: "noop", reason: "テスト" }] } };
      }
    })();
    return Object.assign(gen, { close: () => {} });
  }) as unknown as import("../src/claude.ts").AgentSdk["Service"]["query"];
  class AgentSdk extends actual.AgentSdk {
    static override readonly layer = L.succeed(actual.AgentSdk, actual.AgentSdk.of({ query }));
  }
  return { ...actual, AgentSdk };
});
vi.mock("../src/http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/http.ts")>();
  return { ...actual, openListener: external.openListener };
});

beforeEach(() => {
  external.created.length = 0;
  external.openListener.mockReset();
  external.openListener.mockImplementation(fakeListener().open);
});

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-play-session-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

type Line = Record<string, unknown> & { type: string };

function dependencies(sessionsDir: string) {
  const stdout: string[] = [];
  const consoleService: Console.Console = {
    ...console,
    log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); },
    error: () => {},
  };
  const layer = Layer.mergeAll(
    NodeServices.layer,
    NodeHttpClient.layerUndici,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LIVE_MINDMAP_SESSIONS: sessionsDir, LIVE_MINDMAP_PORT: "0" })),
    Layer.succeed(Console.Console, consoleService),
    Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed("<!doctype html><html><body></body></html>") })),
  );
  return { layer, stdout };
}

// play を 1 回流し、新しいセッションのフォルダを返す（標準出力の 1 行目のパスの親）
const played = (deps: ReturnType<typeof dependencies>, args: string[]) =>
  Effect.gen(function* () {
    yield* runCli(["play", ...args]).pipe(Effect.provide(deps.layer));
    return dirname(deps.stdout.join("").trim().split("\n")[0]!);
  });

const failure = (deps: ReturnType<typeof dependencies>, args: string[]) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(runCli(["play", ...args]).pipe(Effect.provide(deps.layer)));
    expect(result._tag).toBe("Failure"); // 失敗の形を見る前に、失敗したことを確かめる
    return result._tag === "Failure" ? (result.failure as { _tag: string; line?: number; message?: string }) : undefined;
  });

const parseLog = (text: string): Line[] => text.trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Line);
const logLines = (session: string) => parseLog(readFileSync(join(session, "log.jsonl"), "utf8"));
const diffInputs = (lines: Line[]) => lines.filter((l) => l.type === "diff").map((l) => l.input as Record<string, unknown>);
const sessionFolders = (sessionsDir: string) => (existsSync(sessionsDir) ? readdirSync(sessionsDir) : []);

// 元のセッションのフォルダ（log.jsonl と screens/）を手で作る。画像ファイルの中身は渡した文字列
function sessionFolder(root: string, lines: Record<string, unknown>[], images: Record<string, string> = {}) {
  const dir = join(root, "original");
  mkdirSync(join(dir, "screens"), { recursive: true });
  writeFileSync(
    join(dir, "log.jsonl"),
    lines.map((l, i) => JSON.stringify({ at: `2026-10-01T00:00:${String(i).padStart(2, "0")}.000Z`, ...l })).join("\n") + "\n",
  );
  for (const [name, content] of Object.entries(images)) writeFileSync(join(dir, "screens", name), content);
  return dir;
}

const remarkLine = (id: string, start: number, end: number, text = `発言${id}`) => ({
  type: "remark",
  remark: { id, track: "相手", start, end, text },
});

describe("play <セッションのフォルダ>", () => {
  it.effect("共有画面の無いセッションも流せる（発言だけ）。screen の行も screens/ も作らず、発言は元のログのまま入る", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const fixture = parseLog(readFileSync(join(import.meta.dirname, "fixtures/session.log.jsonl"), "utf8"));
      const original = sessionFolder(root, fixture.map(({ at: _at, ...event }) => event));
      const deps = dependencies(join(root, "sessions"));
      const replay = yield* played(deps, [original]);

      expect(external.created.flatMap((c) => c.messages).length).toBeGreaterThan(0);
      const lines = logLines(replay);
      expect(lines.find((l) => l.type === "start")).toMatchObject({ title: "定例" });
      // 発言は remark の行の remark がそのまま入る（重複の印・中身の無い発言の印は中核が付ける）
      const remarks = (list: Line[]) => list.filter((l) => l.type === "remark").map(({ remark, noContent }) => ({ remark, noContent }));
      expect(remarks(lines)).toEqual(remarks(fixture));
      expect(remarks(lines)).toHaveLength(9);
      expect(lines.some((l) => l.type === "screen" || l.type === "screen-off")).toBe(false);
      expect(readdirSync(replay)).not.toContain("screens");
    }));

  it.effect("話者のラベルつきの発言は、差分更新へ送るメッセージに「相手 A:」で届き、ラベルの無い発言は「相手:」のまま。新しいログの remark にもラベルが残る", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const original = sessionFolder(root, [
        { type: "start", title: "話者つき" },
        { ...remarkLine("r1", 0, 5), remark: { ...remarkLine("r1", 0, 5).remark, speaker: "相手 A" } },
        remarkLine("r2", 6, 9),
      ]);
      const replay = yield* played(dependencies(join(root, "sessions")), [original]);

      const sent = external.created
        .flatMap((c) => c.messages)
        .flatMap((m) => (typeof m.message.content === "string" ? [m.message.content] : m.message.content.map((b) => b.text ?? "")))
        .join("\n");
      expect(sent).toContain("r1 [00:00] 相手 A: 発言r1");
      expect(sent).toContain("r2 [00:06] 相手: 発言r2");
      expect(sent).not.toContain("r2 [00:06] 相手 A");
      // 新しいログの remark にも speaker が残る（再生し直しても同じ経路を通る）
      const remarks = logLines(replay).filter((l) => l.type === "remark").map((l) => l.remark as { id: string; speaker?: string });
      expect(remarks.find((r) => r.id === "r1")?.speaker).toBe("相手 A");
      expect(remarks.find((r) => r.id === "r2")).not.toHaveProperty("speaker");
    }));

  describe("ログの読み方", () => {
    it.effect("流さない行（intake-*・diff・知らない type）は、中身が壊れていても読み飛ばす", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory;
        const original = sessionFolder(root, [
          { type: "start", title: "t" },
          { type: "intake-restarted", trigger: "auto" },
          { type: "diff", input: 5 },
          remarkLine("r1", 0, 5),
          { type: "future-event", payload: 1 },
          remarkLine("r2", 6, 9),
        ]);
        const replay = yield* played(dependencies(join(root, "sessions")), [original]);
        expect(logLines(replay).filter((l) => l.type === "remark")).toHaveLength(2);
      }));

    it.effect("自分の休止の行（self-paused・self-resumed）は、中身が壊れていても読み飛ばし、流し直したログにも写さない", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory;
        const original = sessionFolder(root, [
          { type: "start", title: "t" },
          remarkLine("r1", 0, 5),
          { type: "self-paused", reason: "手動", start: 5 },
          { type: "self-resumed", start: "壊れている" },
          remarkLine("r2", 6, 9),
        ]);
        const replay = yield* played(dependencies(join(root, "sessions")), [original]);
        expect(logLines(replay).filter((l) => l.type === "remark")).toHaveLength(2);
        expect(logLines(replay).filter((l) => l.type === "self-paused" || l.type === "self-resumed")).toEqual([]);
      }));

    it.effect("usage つきの diff の行（今の形式）と usage の無い diff の行（古い形式）が混ざったフォルダも、同じように再生できる", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory;
        const diff = { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops: [], dropped: [] };
        const usage = { input: 1, cacheWrite: 2, cacheRead: 3, output: 4, model: "claude-haiku-5-5" };
        const original = sessionFolder(root, [
          { type: "start", title: "t" },
          remarkLine("r1", 0, 5),
          { ...diff, usage },
          remarkLine("r2", 6, 9),
          diff,
        ]);
        const replay = yield* played(dependencies(join(root, "sessions")), [original]);
        expect(logLines(replay).filter((l) => l.type === "remark")).toHaveLength(2);
      }));

    for (const [name, text, line] of [
      ["JSON として壊れた行", '{"type":"start","title":"t"}\n\n{ not json\n', 3],
      ["remark の項目が壊れた行", '{"type":"start","title":"t"}\n\n{"type":"remark","remark":{"id":1}}\n', 3],
    ] as const) {
      it.effect(`${name}は、空行を除く前の行番号つきの BrokenLogLine で失敗し、何も始めない`, () =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory;
          const original = join(root, "original");
          mkdirSync(original);
          writeFileSync(join(original, "log.jsonl"), text);
          const sessionsDir = join(root, "sessions");
          const error = yield* failure(dependencies(sessionsDir), [original]);
          expect(error).toMatchObject({ _tag: "BrokenLogLine", line });
          // 再生を始める前に失敗する: 待受けも新しいセッションのフォルダも作らない
          expect(external.openListener).not.toHaveBeenCalled();
          expect(sessionFolders(sessionsDir)).toEqual([]);
          expect(external.created).toEqual([]);
        }));
    }

    it.effect("start の行が無いログは CommandFailed で失敗する（題名が取れない）", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory;
        const original = sessionFolder(root, [remarkLine("r1", 0, 5)]);
        const sessionsDir = join(root, "sessions");
        expect(yield* failure(dependencies(sessionsDir), [original])).toMatchObject({ _tag: "CommandFailed" });
        expect(sessionFolders(sessionsDir)).toEqual([]);
      }));

    it.effect("log.jsonl が無いフォルダは CommandFailed で失敗する（log.jsonl がありません）", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory;
        const empty = join(root, "empty");
        mkdirSync(empty);
        const sessionsDir = join(root, "sessions");
        const error = yield* failure(dependencies(sessionsDir), [empty]);
        expect(error).toMatchObject({ _tag: "CommandFailed" });
        expect(error!.message).toContain("log.jsonl");
        expect(sessionFolders(sessionsDir)).toEqual([]);
      }));
  });
});
