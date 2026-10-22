import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Console, Context, Deferred, Duration, Effect, Fiber, Layer, Predicate, Queue, Result, Stream, type Cause } from "effect";
import { CliError } from "effect/cli";
import { HttpClient, HttpClientResponse, HttpServer } from "effect/http";
import { afterEach, beforeEach, vi } from "vitest";
import { runCli } from "../src/cli.ts";
import { DiffUpdater, REVIEW_LOG_ELEMENT_ID } from "../src/core/index.ts";
import { ReviewBuild, ReviewPageFailed } from "../src/review.ts";
import type { DiffInput, Op, Snapshot } from "../src/core/index.ts";
import { fakeListener } from "./fakeListener.ts";
import { Helpers, type HelperExitInfo } from "../src/helpers.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { dataRows, isUnmeasured, rowOf } from "./fixtures/latencyTable.ts";
import { readyHelperChecks } from "./fixtures/helperCheck.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";

// play の updater（claude.ts）と配信の待受け（http.ts の openListener）を差し替える。待受けは既定で偽物にし、
// 本物の WebSocket 越しに観測する 1 本だけ、実物の openListener に戻す
const external = vi.hoisted(() => ({
  openClaudeUpdater: vi.fn(),
  openListener: vi.fn(),
  realHttp: { current: null as null | typeof import("../src/http.ts") },
}));
vi.mock("../src/claude.ts", async () => (await import("./fixtures/claudeModule.ts")).fakeClaudeModule(() => external.openClaudeUpdater()));
vi.mock("../src/http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/http.ts")>();
  external.realHttp.current = actual;
  return { ...actual, openListener: external.openListener };
});

const fixture = join(import.meta.dirname, "fixtures/short.transcript.json");

const script: Op[][] = [
  [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] }],
  [{ op: "add", ref: "t2", parent: "n1", kind: "論点", text: "面接は何回か", evidence: ["r2"] }],
  [{ op: "add", ref: "t3", parent: "n2", kind: "決定", text: "2 回にする", evidence: ["r3"] }],
];

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

// 保存先とポートは ConfigProvider、標準出力は Console、見返しの HTML のビルドは ReviewBuild の Layer で渡す
function dependencies(sessionsDir: string, port = "0") {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const reviewFailure = { error: null as ReviewPageFailed | null };
  const consoleService: Console.Console = {
    ...console,
    log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); },
    error: (...args: unknown[]) => { stderr.push(args.map(String).join(" ") + "\n"); },
  };
  const layer = Layer.mergeAll(
    NodeServices.layer,
    NodeHttpClient.layerUndici,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LIVE_MINDMAP_SESSIONS: sessionsDir, LIVE_MINDMAP_PORT: port })),
    Layer.succeed(Console.Console, consoleService),
    Layer.succeed(ReviewBuild, ReviewBuild.of({
      build: Effect.suspend(() => reviewFailure.error ? Effect.fail(reviewFailure.error) : Effect.succeed("<!doctype html><html><body></body></html>")),
    })),
  );
  return { layer, stdout, stderr, reviewFailure };
}

// 既定の updater。script を順に返す
function scripted(ops: Op[][] = script) {
  const calls: DiffInput[] = [];
  const close = vi.fn();
  external.openClaudeUpdater.mockReturnValue({
    update: (input: DiffInput) => Effect.sync(() => {
      calls.push(input);
      return { ops: ops[calls.length - 1] ?? [] };
    }),
    close,
  });
  return { calls, close };
}

beforeEach(() => {
  external.openClaudeUpdater.mockReset();
  external.openListener.mockReset();
  scripted();
  external.openListener.mockImplementation(fakeListener().open);
});
afterEach(() => vi.restoreAllMocks());

const played = (deps: ReturnType<typeof dependencies>) => Effect.gen(function* () {
  yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));
  const paths = deps.stdout.join("").trim().split("\n");
  deps.stdout.length = 0;
  return { paths, session: dirname(paths[0]!) };
});

describe("CLI", () => {
  it.effect("文字起こしを再生すると、export --format json がその時点のマップを標準出力に出す", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    const { calls } = scripted();

    yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));
    expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1"], ["r2"], ["r3"]]);

    deps.stdout.length = 0;
    yield* runCli(["export", "--format", "json"]).pipe(Effect.provide(deps.layer));
    const exported = JSON.parse(deps.stdout.join(""));
    expect(exported.root).toMatchObject({
      kind: "会議",
      children: [
        {
          kind: "議題",
          text: "採用",
          children: [
            {
              kind: "論点",
              text: "面接は何回か",
              pointStatus: "決定済み",
              children: [
                {
                  kind: "決定",
                  text: "2 回にする",
                  evidence: [{ id: "r3", track: "相手", start: 19.2, end: 28.0, text: "2 回にしましょう" }],
                },
              ],
            },
          ],
        },
      ],
    });
  }));

  it.effect("再生が終わると、ログと同じフォルダに map.md・map.json・map.drawnix・map.html を書き出し、そのパスを順に出力する", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    const { paths, session } = yield* played(deps);

    expect(paths).toEqual([join(session, "map.md"), join(session, "map.json"), join(session, "map.drawnix"), join(session, "map.html")]);
    const files = yield* Effect.tryPromise(() => readdir(session));
    expect(files.sort()).toEqual(expect.arrayContaining(["log.jsonl", "map.md", "map.json", "map.drawnix", "map.html"]));
    const md = yield* Effect.tryPromise(() => readFile(join(session, "map.md"), "utf8"));
    expect(md).toContain("# short");
    expect(md).toContain("面接は何回か → 2 回にする");
    const drawnix = JSON.parse(yield* Effect.tryPromise(() => readFile(join(session, "map.drawnix"), "utf8")));
    expect(drawnix).toMatchObject({ type: "drawnix", elements: [{ type: "mindmap" }] });
  }));

  it.effect("map.html には log.jsonl の出来事がそのまま埋め込まれる（偽のビルドのテンプレートに差し込む）", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    const { session } = yield* played(deps);

    const log = (yield* Effect.tryPromise(() => readFile(join(session, "log.jsonl"), "utf8")))
      .split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
    const html = yield* Effect.tryPromise(() => readFile(join(session, "map.html"), "utf8"));
    const match = new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
    expect(match).not.toBeNull();
    expect(match![1]).not.toContain("<");
    expect(JSON.parse(match![1]!)).toEqual(log);
    expect(log.length).toBeGreaterThan(0);
  }));

  it.effect("再生で map.html のビルドが失敗しても、ほかの 3 つを書き、そのパスを出す。理由は標準エラーに残し、map.html は作らない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    deps.reviewFailure.error = new ReviewPageFailed({ message: "ビルドに失敗" });

    yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));

    expect(deps.stderr.join("")).toContain("map.html を書き出せませんでした: ビルドに失敗");
    const [session] = yield* Effect.tryPromise(() => readdir(dir));
    const files = yield* Effect.tryPromise(() => readdir(join(dir, session!)));
    expect(files).toEqual(expect.arrayContaining(["map.md", "map.json", "map.drawnix"]));
    expect(files).not.toContain("map.html");
    expect(deps.stdout.join("").trim().split("\n").map((l) => basename(l))).toEqual(["map.md", "map.json", "map.drawnix"]);
  }));

  it.effect("再生の map.html のビルドの失敗の理由に改行があっても、標準エラーの警告は 1 行にする", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    deps.reviewFailure.error = new ReviewPageFailed({ message: "ビルドに失敗\n詳細" });

    yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));

    expect(deps.stderr).toContain("map.html を書き出せませんでした: ビルドに失敗 詳細\n");
  }));

  it.effect("再生の最後にテキストの 3 形式を書けないときは、CommandFailed で失敗し、理由を 1 行で伝える。パスは出さない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    external.openClaudeUpdater.mockReturnValue({
      update: () => Effect.sync(() => {
        const [session] = readdirSync(dir);
        mkdirSync(join(dir, session!, "map.md")); // 書き先と同名のフォルダがあり、map.md を書けない
        return { ops: [] };
      }),
      close: vi.fn(),
    });

    const result = yield* Effect.result(runCli(["play", fixture]).pipe(Effect.provide(deps.layer)));

    expect(Result.isFailure(result)).toBe(true);
    const failure = Result.isFailure(result) ? (result.failure as { _tag: string; message: string }) : undefined;
    expect(failure?._tag).toBe("CommandFailed");
    expect(failure?.message).toContain("map.md");
    expect(failure?.message).not.toContain("\n");
    expect(deps.stdout).toEqual([]);
  }));

  it.effect("map.json は、直後の export --format json の出力と同じ内容", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    const { session } = yield* played(deps);

    yield* runCli(["export", "--format", "json"]).pipe(Effect.provide(deps.layer));
    expect(yield* Effect.tryPromise(() => readFile(join(session, "map.json"), "utf8"))).toBe(deps.stdout.join(""));
  }));

  it.effect("形式を指定しない export は Markdown を標準出力に出し、ファイルは作らない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    const { session } = yield* played(deps);
    const before = (yield* Effect.tryPromise(() => readdir(session))).sort();

    yield* runCli(["export"]).pipe(Effect.provide(deps.layer));
    const md = deps.stdout.join("");
    expect(md.startsWith("# short")).toBe(true);
    expect(md).toContain("面接は何回か → 2 回にする");
    expect((yield* Effect.tryPromise(() => readdir(session))).sort()).toEqual(before);
    expect(md).toBe(yield* Effect.tryPromise(() => readFile(join(session, "map.md"), "utf8")));
  }));

  it.effect("再生の途中でも、export はその時点のマップを標準出力に出し、ファイルは作らない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    const reachedThird = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    external.openClaudeUpdater.mockReturnValue({
      update: () => Effect.suspend(() => {
        const ops = script[calls++] ?? [];
        if (calls === 3) {
          Deferred.doneUnsafe(reachedThird, Effect.void);
          return Deferred.await(release).pipe(Effect.as({ ops })); // 3 回目（r3）の更新が終わらない、進行中の状態で止める
        }
        return Effect.succeed({ ops });
      }),
      close: () => {},
    });

    const playing = yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer), Effect.forkChild);
    yield* Deferred.await(reachedThird);

    const [session] = yield* Effect.tryPromise(() => readdir(dir));
    const sessionDir = join(dir, session!);
    const before = (yield* Effect.tryPromise(() => readdir(sessionDir))).sort();
    expect(before).toEqual(["export.json", "log.jsonl"]);

    yield* runCli(["export"]).pipe(Effect.provide(deps.layer));
    const md = deps.stdout.join("");
    expect(md.startsWith("# short")).toBe(true);
    expect(md).toContain("面接は何回か（未決）");
    expect(md).not.toContain("→ 決定");

    deps.stdout.length = 0;
    yield* runCli(["export", "--format", "json"]).pipe(Effect.provide(deps.layer));
    const exported = JSON.parse(deps.stdout.join(""));
    expect(exported.root.children[0].children[0]).toMatchObject({ kind: "論点", text: "面接は何回か", pointStatus: "未決", children: [] });
    expect((yield* Effect.tryPromise(() => readdir(sessionDir))).sort()).toEqual(before);

    Deferred.doneUnsafe(release, Effect.void);
    yield* Fiber.join(playing);
  }));

  it.effect("--realtime を付けない再生は、仮想時計を進めなくても終わる（待ち時間なし）", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    // it.effect は TestClock なので、再生が待てばこの Effect は終わらない
    yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));
  }));

  describe("play の差分更新（claude.ts）", () => {
    it.effect("再生のために 1 つ開き、1 回の再生の全発言を同じ updater に渡し、再生が終わったら閉じる", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { calls, close } = scripted();

      yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));

      expect(external.openClaudeUpdater).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(3);
      expect(close).toHaveBeenCalledTimes(1);
    }));

    it.effect("再生が失敗しても、開いた updater は閉じる", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { close } = scripted();

      const result = yield* Effect.result(
        runCli(["play", join(dir, "無い.transcript.json")]).pipe(Effect.provide(deps.layer)),
      );

      expect(Result.isFailure(result)).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
    }));
  });

  // helper の stt-file --transcript が書く形（track は microphone、本文は偽の STT の「（音声 a.b–c.d 秒）」）。
  // 同じ録音を VAD の無音の長さだけ替えた 2 本（区切りが違う）が、どちらも play で流せる
  describe("play: stt-file の文字起こし（無音の長さ違いの 2 本）", () => {
    const segment = (start: number, end: number) => ({ track: "microphone", start_seconds: start, end_seconds: end, text: `（音声 ${start.toFixed(1)}–${end.toFixed(1)} 秒）` });
    const transcript = (...segments: ReturnType<typeof segment>[]) => JSON.stringify({ transcript: { segments } });

    it.effect("区切りの違う 2 本は、どちらも play でき、それぞれの発言（自分）が区切りどおりに updater へ渡る", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const split = join(dir, "silence-0.5.transcript.json");
      const joined = join(dir, "silence-2.0.transcript.json");
      writeFileSync(split, transcript(segment(0, 1.2), segment(2.2, 3.4)));
      writeFileSync(joined, transcript(segment(0, 3.4)));

      const played = (path: string) => Effect.gen(function* () {
        const deps = dependencies(dir);
        const { calls } = scripted([]);
        yield* runCli(["play", path]).pipe(Effect.provide(deps.layer));
        return calls.flatMap((c) => c.fresh.map((u) => ({ id: u.id, track: u.track, start: u.start, end: u.end, text: u.text })));
      });

      expect(yield* played(split)).toEqual([
        { id: "r1", track: "自分", start: 0, end: 1.2, text: "（音声 0.0–1.2 秒）" },
        { id: "r2", track: "自分", start: 2.2, end: 3.4, text: "（音声 2.2–3.4 秒）" },
      ]);
      expect(yield* played(joined)).toEqual([{ id: "r1", track: "自分", start: 0, end: 3.4, text: "（音声 0.0–3.4 秒）" }]);
    }));
  });

  describe("restore", () => {
    const adoptionScript: Op[][] = script;

    // sessionsDir に script で 1 セッション再生し、そのフォルダと export の出力を返す
    const playInto = (deps: ReturnType<typeof dependencies>, ops: Op[][]) => Effect.gen(function* () {
      scripted(ops);
      yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));
      const session = dirname(deps.stdout.join("").split("\n")[0]!); // play は書き出したファイルのパスを出す（#41）
      deps.stdout.length = 0;
      yield* runCli(["export", "--format", "json"]).pipe(Effect.provide(deps.layer));
      const before = deps.stdout.join("");
      deps.stdout.length = 0;
      return { session, before };
    });

    it.effect("落ちた後に、ログから差分更新を呼ばずに元と同じマップへ戻し、export で読める", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session, before } = yield* playInto(deps, adoptionScript);
      // 落ちた状態: エクスポートは残っておらず、ログには知らない種類の行がある
      rmSync(join(session, "export.json"));
      appendFileSync(join(session, "log.jsonl"), JSON.stringify({ type: "jev", at: "2026-10-01T00:00:00.000Z" }) + "\n");
      external.openClaudeUpdater.mockReset();

      yield* runCli(["restore"]).pipe(Effect.provide(deps.layer));
      expect(deps.stdout.join("").trim()).toBe(session);
      expect(external.openClaudeUpdater).not.toHaveBeenCalled();

      deps.stdout.length = 0;
      yield* runCli(["export", "--format", "json"]).pipe(Effect.provide(deps.layer));
      expect(deps.stdout.join("")).toBe(before);
    }));

    it.effect("復元してもログを書き足さない", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* playInto(deps, adoptionScript);
      const logBefore = readFileSync(join(session, "log.jsonl"), "utf8");

      yield* runCli(["restore"]).pipe(Effect.provide(deps.layer));
      expect(readFileSync(join(session, "log.jsonl"), "utf8")).toBe(logBefore);
    }));

    it.effect("ログの行が JSON として壊れていれば、タグ付きの失敗にする", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* playInto(deps, adoptionScript);
      const lines = readFileSync(join(session, "log.jsonl"), "utf8").split("\n");
      lines.splice(1, 0, "{壊れた行");
      writeFileSync(join(session, "log.jsonl"), lines.join("\n"));

      const result = yield* Effect.result(runCli(["restore"]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(Predicate.hasProperty(result.failure, "_tag")).toBe(true);
      expect(CliError.isCliError(result.failure)).toBe(false);
      // 行番号付きの日本語 1 行は、入口の表を通す cliProcess.heavy.test.ts で観測する
      expect(deps.stdout).toEqual([]);
      expect(deps.stderr).toEqual([]);
    }));

    // JSON としては読めるが、type が remark の項目が壊れた行（InvalidLogEvent）は、空行を除く前の行番号の BrokenLogLine にする
    it.effect("JSON としては正しいが Schema として壊れた行は、空行を含む元の行番号の BrokenLogLine にする。差分更新は開かない", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* playInto(deps, adoptionScript);
      const lines = readFileSync(join(session, "log.jsonl"), "utf8").split("\n");
      lines.splice(1, 0, "", "", JSON.stringify({ type: "remark", at: "2026-10-01T00:00:00.000Z" })); // 空行 2 つの後の 4 行目
      writeFileSync(join(session, "log.jsonl"), lines.join("\n"));
      external.openClaudeUpdater.mockReset();

      const result = yield* Effect.result(runCli(["restore"]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "BrokenLogLine", line: 4 });
      expect(CliError.isCliError(result.failure)).toBe(false);
      expect(external.openClaudeUpdater).not.toHaveBeenCalled();
      expect(deps.stdout).toEqual([]);
    }));

    it.effect("セッションが複数あれば最新のものを復元し、export がその最新のマップを出す", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const first = yield* playInto(deps, adoptionScript);
      const oldDir = join(dir, "2000-01-01T00-00-00.000Z");
      renameSync(first.session, oldDir);
      const second = yield* playInto(deps, [[{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "予算", evidence: ["r1"] }]]);
      expect(second.session).not.toBe(oldDir);
      expect(first.before).not.toBe(second.before);
      rmSync(join(second.session, "export.json"));

      yield* runCli(["restore"]).pipe(Effect.provide(deps.layer));
      expect(deps.stdout.join("").trim()).toBe(second.session);

      deps.stdout.length = 0;
      yield* runCli(["export", "--format", "json"]).pipe(Effect.provide(deps.layer));
      expect(deps.stdout.join("")).toBe(second.before);
    }));

    it.effect("ログのない、より新しいフォルダがあっても、ログのある最新のセッションを復元する", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* playInto(deps, adoptionScript);
      mkdirSync(join(dir, "9999-12-31T00-00-00.000Z"));

      yield* runCli(["restore"]).pipe(Effect.provide(deps.layer));
      expect(deps.stdout.join("").trim()).toBe(session);
    }));

    // Issue #645: 終了の処理を通らなかったセッションも、restore で組み直したときに語彙の溜まりの更新に含める。
    // 溜まりの更新は、ログの vocab-pool の行（そのセッションの番号）と vocab・remark の行から導く。ログは書き足さない
    it.effect("セッションがなければタグ付きの失敗にする", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);

      const result = yield* Effect.result(runCli(["restore"]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(Predicate.hasProperty(result.failure, "_tag")).toBe(true);
      expect(CliError.isCliError(result.failure)).toBe(false);
      // 「セッションがありません: <パス>」の 1 行は cliProcess.heavy.test.ts で観測する
      expect(deps.stdout).toEqual([]);
      expect(deps.stderr).toEqual([]);
    }));
  });

  // Issue #646: cli vocab list / forget。サーバーを使わず、セッションの置き場の vocabulary.json を直接読み書きする
  describe("review", () => {
    const embedded = (html: string) => {
      const match = new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
      return match === null ? null : (JSON.parse(match[1]!) as unknown[]);
    };
    const logOf = (session: string) =>
      readFileSync(join(session, "log.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as unknown);
    // フォルダ直下のファイルの中身（map.html 以外）
    const snapshotExceptHtml = (session: string) =>
      Object.fromEntries(readdirSync(session).filter((f) => f !== "map.html").sort().map((f) => [f, readFileSync(join(session, f), "utf8")]));

    it.effect("引数を省略すると、log.jsonl を持つ最新のセッションの map.html を確認なしで上書きし、そのパスだけを 1 行に出す", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* played(deps);
      writeFileSync(join(session, "map.html"), "古い");

      yield* runCli(["review"]).pipe(Effect.provide(deps.layer));

      expect(deps.stdout.join("")).toBe(`${join(session, "map.html")}\n`);
      expect(deps.stderr).toEqual([]);
      const html = readFileSync(join(session, "map.html"), "utf8");
      expect(html).not.toBe("古い");
      expect(embedded(html)).toEqual(logOf(session));
    }));

    it.effect("ログのない、より新しいフォルダがあっても、ログのある最新のセッションを対象にする", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* played(deps);
      rmSync(join(session, "map.html"));
      const empty = join(dir, "9999-12-31T00-00-00.000Z");
      mkdirSync(empty);

      yield* runCli(["review"]).pipe(Effect.provide(deps.layer));

      expect(deps.stdout.join("")).toBe(`${join(session, "map.html")}\n`);
      expect(existsSync(join(session, "map.html"))).toBe(true);
      expect(readdirSync(empty)).toEqual([]);
    }));

    it.effect("相対パスで渡したフォルダも受け、最新ではなくそのフォルダに書き、出力は絶対パスにする", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const first = yield* played(deps);
      const oldDir = join(dir, "2000-01-01T00-00-00.000Z");
      renameSync(first.session, oldDir);
      const second = yield* played(deps);
      expect(second.session).not.toBe(oldDir);
      rmSync(join(oldDir, "map.html"));
      rmSync(join(second.session, "map.html"));

      yield* runCli(["review", relative(process.cwd(), oldDir)]).pipe(Effect.provide(deps.layer));

      expect(deps.stdout.join("")).toBe(`${join(oldDir, "map.html")}\n`);
      expect(existsSync(join(oldDir, "map.html"))).toBe(true);
      expect(existsSync(join(second.session, "map.html"))).toBe(false);
    }));

    it.effect("絶対パスで渡したフォルダも受ける", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* played(deps);
      rmSync(join(session, "map.html"));

      yield* runCli(["review", session]).pipe(Effect.provide(deps.layer));

      expect(deps.stdout.join("")).toBe(`${join(session, "map.html")}\n`);
      expect(existsSync(join(session, "map.html"))).toBe(true);
    }));

    it.effect("map.html 以外（md・json・drawnix・png・export.json・log.jsonl）は書き直さず、ファイルも増やさない。撮影もしない", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* played(deps);
      const before = snapshotExceptHtml(session);
      expect(Object.keys(before)).toEqual(expect.arrayContaining(["export.json", "log.jsonl", "map.md", "map.json", "map.drawnix"]));

      yield* runCli(["review"]).pipe(Effect.provide(deps.layer));

      expect(snapshotExceptHtml(session)).toEqual(before);
    }));

    it.effect("サーバーにつながず、進行中のセッションでも、その時点の log.jsonl をそのまま読んで作る", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* played(deps);
      appendFileSync(join(session, "log.jsonl"), JSON.stringify({ type: "進行中の行", at: "2026-10-01T00:00:00.000Z" }) + "\n");
      external.openListener.mockClear();

      yield* runCli(["review"]).pipe(Effect.provide(deps.layer));

      expect(external.openListener).not.toHaveBeenCalled();
      const events = embedded(readFileSync(join(session, "map.html"), "utf8"));
      expect(events).toEqual(logOf(session));
      expect(events).toContainEqual({ type: "進行中の行", at: "2026-10-01T00:00:00.000Z" });
    }));

    it.effect("ポートの設定を読まない。不正な LIVE_MINDMAP_PORT でも成功し、map.html を書いて絶対パスを出す", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const { session } = yield* played(dependencies(dir));
      rmSync(join(session, "map.html"));
      const deps = dependencies(dir, "ポートではない");

      yield* runCli(["review"]).pipe(Effect.provide(deps.layer));

      expect(deps.stdout.join("")).toBe(`${join(session, "map.html")}\n`);
      expect(embedded(readFileSync(join(session, "map.html"), "utf8"))).toEqual(logOf(session));
    }));

    it.effect("存在しないフォルダは、何も書かず、そのパスを含む CommandFailed で失敗する", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const missing = join(dir, "ない");

      const result = yield* Effect.result(runCli(["review", missing]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "CommandFailed" });
      expect((result.failure as { message: string }).message).toContain(missing);
      expect(deps.stdout).toEqual([]);
      expect(existsSync(missing)).toBe(false);
    }));

    it.effect("log.jsonl が無いフォルダは、何も書かず、そのパスを含む CommandFailed で失敗する", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* played(deps);
      rmSync(join(session, "log.jsonl"));
      rmSync(join(session, "map.html"));

      const result = yield* Effect.result(runCli(["review", session]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "CommandFailed" });
      expect((result.failure as { message: string }).message).toContain(session);
      expect(deps.stdout).toEqual([]);
      expect(existsSync(join(session, "map.html"))).toBe(false);
    }));

    it.effect("ビルドが失敗したら、map.html を書き出せませんでした: <理由> の CommandFailed で失敗し、何も書かない", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* played(deps);
      rmSync(join(session, "map.html"));
      deps.reviewFailure.error = new ReviewPageFailed({ message: "ビルドに失敗" });

      const result = yield* Effect.result(runCli(["review"]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "CommandFailed", message: "map.html を書き出せませんでした: ビルドに失敗" });
      expect(deps.stdout).toEqual([]);
      expect(existsSync(join(session, "map.html"))).toBe(false);
    }));

    it.effect("ログに壊れた行があれば、map.html を書き出せませんでした: で始まる CommandFailed で失敗し、前の map.html を変えない", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* played(deps);
      writeFileSync(join(session, "map.html"), "前の内容");
      appendFileSync(join(session, "log.jsonl"), "{壊れた行\n");

      const result = yield* Effect.result(runCli(["review"]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "CommandFailed" });
      expect((result.failure as { message: string }).message).toMatch(/^map\.html を書き出せませんでした: /);
      expect(deps.stdout).toEqual([]);
      expect(readFileSync(join(session, "map.html"), "utf8")).toBe("前の内容");
    }));

    it.effect("引数を省略してセッションが 1 つも無ければ、何も書かず、タグ付きの失敗にする", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);

      const result = yield* Effect.result(runCli(["review"]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "NoSession" });
      expect(deps.stdout).toEqual([]);
      expect(readdirSync(dir)).toEqual([]);
    }));
  });

  describe("latency", () => {
    const W = 1_000_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    // 発言 1 件を 1 回の diff で反映した、手書きのログ。callMs は呼び出しの長さ。本文は text・raw・words に入れる
    const logWith = (text: string, callMs: number, withOrigin = true) => [
      { type: "start", title: "会議" },
      ...(withOrigin ? [{ type: "origin", wallTime: W, at: iso(W) }] : []),
      { type: "remark", remark: { id: "r1", track: "自分", start: 9, end: 10, text }, raw: text, words: [{ text, start: 9, end: 10 }], settledAt: W + 10_100, shownAt: W + 10_800, at: iso(W + 10_110) },
      { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops: [], dropped: [], at: iso(W + 10_130 + callMs + 50), call: { startedAt: iso(W + 10_130), endedAt: iso(W + 10_130 + callMs) } },
    ];
    const writeSession = (dir: string, name: string, events: unknown[]) => {
      const session = join(dir, name);
      mkdirSync(session);
      writeFileSync(join(session, "log.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      return session;
    };

    it.effect("フォルダを渡すと、トラック × 区間の表を標準出力に出す。本文はどこにも出ない。サーバーにはつながない", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const session = writeSession(dir, "2026-01-01T00-00-00.000Z", logWith("秘密の本文です", 1000));

      yield* runCli(["latency", session]).pipe(Effect.provide(deps.layer));

      const out = deps.stdout.join("");
      expect(dataRows(out)).toHaveLength(12);
      expect(rowOf(out, "自分", "call").slice(2)).toEqual(["1", "1000", "1000", "1000"]);
      expect(rowOf(out, "自分", "shown")[2]).toBe("1");
      expect(rowOf(out, "相手", "applied")).toSatisfy(isUnmeasured);
      expect(out).not.toContain("秘密の本文");
      expect(out).not.toContain("r1");
      expect(deps.stderr).toEqual([]);
      expect(external.openListener).not.toHaveBeenCalled();
      expect(external.openClaudeUpdater).not.toHaveBeenCalled();
    }));

    it.effect("引数を省略すると、log.jsonl を持つ最新のセッションを集計する（ログのない、より新しいフォルダと古いセッションは使わない）", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      writeSession(dir, "2026-01-01T00-00-00.000Z", logWith("古い", 1000));
      writeSession(dir, "2026-02-01T00-00-00.000Z", logWith("新しい", 2000));
      mkdirSync(join(dir, "9999-12-31T00-00-00.000Z"));

      yield* runCli(["latency"]).pipe(Effect.provide(deps.layer));

      expect(rowOf(deps.stdout.join(""), "自分", "call").slice(2)).toEqual(["1", "2000", "2000", "2000"]);
    }));

    it.effect("フォルダを渡したときは、最新ではなくそのフォルダを集計する", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const older = writeSession(dir, "2026-01-01T00-00-00.000Z", logWith("古い", 1000));
      writeSession(dir, "2026-02-01T00-00-00.000Z", logWith("新しい", 2000));

      yield* runCli(["latency", older]).pipe(Effect.provide(deps.layer));

      expect(rowOf(deps.stdout.join(""), "自分", "call").slice(2)).toEqual(["1", "1000", "1000", "1000"]);
    }));

    it.effect("origin の行が無いログは、すべての区間を計測なしと表示して成功する（0 や NaN にしない）", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const session = writeSession(dir, "2026-01-01T00-00-00.000Z", logWith("本文", 1000, false));

      yield* runCli(["latency", session]).pipe(Effect.provide(deps.layer));

      const out = deps.stdout.join("");
      expect(dataRows(out)).toHaveLength(12);
      for (const cells of dataRows(out)) expect(isUnmeasured(cells), cells.join("|")).toBe(true);
      expect(out).not.toMatch(/NaN|undefined/);
    }));

    it.effect("本文を替えても表は同じになる", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const a = writeSession(dir, "2026-01-01T00-00-00.000Z", logWith("予算の話", 1000));
      const b = writeSession(dir, "2026-02-01T00-00-00.000Z", logWith("まったく別の長い本文".repeat(10), 1000));

      yield* runCli(["latency", a]).pipe(Effect.provide(deps.layer));
      yield* runCli(["latency", b]).pipe(Effect.provide(deps.layer));

      expect(deps.stdout).toHaveLength(2);
      expect(deps.stdout[1]).toBe(deps.stdout[0]);
    }));

    it.effect("log.jsonl が無いフォルダは、何も出さず、そのパスを含む CommandFailed で失敗する", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const empty = join(dir, "空");
      mkdirSync(empty);

      const result = yield* Effect.result(runCli(["latency", empty]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "CommandFailed" });
      expect((result.failure as { message: string }).message).toContain(empty);
      expect(deps.stdout).toEqual([]);
    }));

    it.effect("引数を省略してセッションが 1 つも無ければ、何も出さず、NoSession で失敗する", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);

      const result = yield* Effect.result(runCli(["latency"]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "NoSession" });
      expect(deps.stdout).toEqual([]);
    }));

    it.effect("ログに壊れた行があれば、何も出さず、BrokenLogLine で失敗する", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const session = writeSession(dir, "2026-01-01T00-00-00.000Z", logWith("本文", 1000));
      appendFileSync(join(session, "log.jsonl"), "{壊れた行\n");

      const result = yield* Effect.result(runCli(["latency", session]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "BrokenLogLine" });
      expect(deps.stdout).toEqual([]);
    }));

    it.effect("既知の種類の行で項目が壊れていれば、何も出さず、BrokenLogLine で失敗する", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const events = logWith("本文", 1000).map((e) => (e.type === "remark" ? { ...e, settledAt: "あとで" } : e));
      const session = writeSession(dir, "2026-01-01T00-00-00.000Z", events);

      const result = yield* Effect.result(runCli(["latency", session]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "BrokenLogLine", line: 3 });
      expect(deps.stdout).toEqual([]);
    }));

    it.effect("play（待たない再生）のログには origin の行が無く、latency はすべて計測なしと表示する", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* played(deps);

      expect(readFileSync(join(session, "log.jsonl"), "utf8")).not.toContain('"type":"origin"');
      yield* runCli(["latency", session]).pipe(Effect.provide(deps.layer));

      const out = deps.stdout.join("");
      expect(dataRows(out)).toHaveLength(12);
      for (const cells of dataRows(out)) expect(isUnmeasured(cells), cells.join("|")).toBe(true);
    }));
  });

  describe("保存先に通常ファイルがあるとき", () => {
    it.effect("セッションと通常ファイルが混在しても、restore は最新の有効なセッションを処理する", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* played(deps);
      writeFileSync(join(dir, "9999-12-31T00-00-00.000Z"), "");

      yield* runCli(["restore"]).pipe(Effect.provide(deps.layer));

      expect(deps.stdout.join("")).toContain(session);
    }));

    it.effect("保存先の直下が通常ファイルだけなら、export は NoSession になる", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      writeFileSync(join(dir, "9999-12-31T00-00-00.000Z"), "");

      const result = yield* Effect.result(runCli(["export"]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "NoSession" });
      expect(deps.stdout).toEqual([]);
    }));

    it.effect("保存先そのものが通常ファイルなら、export は defect ではなく CommandFailed になる", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const file = join(dir, "sessions-file");
      writeFileSync(file, "");
      const deps = dependencies(file);

      const result = yield* Effect.result(runCli(["export"]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "CommandFailed" });
      expect(deps.stdout).toEqual([]);
    }));

    it.effect("review に通常ファイルを渡すと、log.jsonl がありません の CommandFailed になる", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const file = join(dir, "plain-file");
      writeFileSync(file, "");
      const deps = dependencies(dir);

      const result = yield* Effect.result(runCli(["review", file]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "CommandFailed", message: `log.jsonl がありません: ${join(file, "log.jsonl")}` });
    }));

    it.effect("eval に通常ファイルを渡すと、MissingRunExport になる", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const file = join(dir, "plain-file");
      writeFileSync(file, "");
      const deps = dependencies(dir);

      const result = yield* Effect.result(runCli(["eval", file]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "MissingRunExport" });
    }));
  });

  describe("ブラウザへの配信", () => {
    // 本物の WebSocket 越しに観測するのは、このファイルで 1 本だけ（正本 22 行）。
    // 「失敗した反映では送らない」「終わると閉じる」は、偽の待受け（fakeListener）で同じ契約を観測する
    it.live("反映のたびに、マップ全体のスナップショットが WebSocket で届く（初期のルート＋反映ごとに 1 つ）。標準出力は変わらない", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const listening = yield* Deferred.make<number>();
      const http = external.realHttp.current!;
      external.openListener.mockImplementation((port: number) =>
        Effect.tap(http.openListener(port), (context) => Effect.flatMap(http.portOf(Context.get(context, HttpServer.HttpServer).address), (p) => Deferred.succeed(listening, p))));

      const received: Snapshot[] = [];
      let firstReceived: () => void = () => {};
      const first = new Promise<void>((resolve) => (firstReceived = resolve));
      let n = 0;
      external.openClaudeUpdater.mockReturnValue({
        update: () =>
          Effect.promise(() => first).pipe( // 接続して最初のスナップショットが届くまで、反映を待たせる
            Effect.map(() => ({ ops: script[n++] ?? [] })),
          ),
        close: () => {},
      });

      const playing = yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer), Effect.forkChild);
      const port = yield* Deferred.await(listening);
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.addEventListener("message", (e) => {
        const frame = JSON.parse(String(e.data)) as Snapshot | { type: string };
        if (!("type" in frame)) {
          received.push(frame);
          firstReceived();
        }
      });
      yield* Fiber.join(playing);
      yield* Effect.sleep(100); // close 前に送られたものが届くのを待つ
      ws.close();

      expect(received.map((s) => s.nodes.length)).toEqual([1, 2, 3, 4]);
      expect(received[0]!.nodes.map((x) => x.kind)).toEqual(["会議"]);
      const last = received.at(-1)!;
      expect(last.nodes.map((x) => x.text)).toEqual(["short", "採用", "面接は何回か", "2 回にする"]);
      expect(last.nodes.find((x) => x.kind === "論点")).toMatchObject({ pointStatus: "決定済み" });
      // 反映ごとに round が進み、その反映の新しい発言（1 件ずつ渡る）の end を時刻として、記録が積み上がって届く
      expect(received.map((s) => s.round)).toEqual([0, 1, 2, 3]);
      expect(received[0]!.changes).toEqual([]);
      expect(received[1]!.changes).toEqual([
        { round: 1, at: 9.8, change: "追加", node: "n1", kind: "議題", text: "採用" },
      ]);
      expect(received[2]!.changes).toEqual([
        ...received[1]!.changes,
        { round: 2, at: 19.2, change: "追加", node: "n2", kind: "論点", text: "面接は何回か" },
      ]);
      expect(last.changes).toEqual([
        ...received[2]!.changes,
        { round: 3, at: 28, change: "決定済み化", node: "n2", kind: "論点", text: "面接は何回か" },
        { round: 3, at: 28, change: "追加", node: "n3", kind: "決定", text: "2 回にする" },
      ]);
      // 根拠: 届いたスナップショットから、ノードの根拠の ID で発言（時刻・本文）を引ける
      const n1 = last.nodes.find((x) => x.id === "n1")!;
      const r1 = last.remarks.find((r) => r.id === n1.evidence[0])!;
      expect(r1).toMatchObject({ start: 0.5, end: 9.8, text: "今日は採用の進め方を決めます" });
      expect(["自分", "相手"]).toContain(r1.track);
      for (const node of last.nodes) for (const id of node.evidence) expect(last.remarks.some((r) => r.id === id)).toBe(true);
      expect(deps.stdout.join("")).toMatch(/^([^\n]+\n){4}$/); // 書き出した 5 ファイルのパスだけ
    }));

    it.effect("失敗した反映（マップが変わらない）ではスナップショットを送らない", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const fake = fakeListener();
      external.openListener.mockImplementation(fake.open);
      let n = 0;
      external.openClaudeUpdater.mockReturnValue({
        update: () => Effect.suspend(() =>
          n++ === 0 ? Effect.fail({ _tag: "FakeUpdateFailed", message: "失敗" }) : Effect.succeed({ ops: [] as Op[] })),
        close: () => {},
      });

      yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));

      // 失敗した回の発言は順番待ちの頭へ戻り、1 秒の間隔を置いて呼び直す。再生が終わる（flush）ときは待たずに戻るので、呼び出しは失敗した 1 回だけ
      expect(n).toBe(1); // 更新へ到達したうえで
      expect(fake.published.map((s) => s.nodes.length)).toEqual([1]); // 初期のルートだけ。失敗した回は送らない
      expect(fake.published.map((s) => s.round)).toEqual([0]);
    }));

    it.effect("再生が終わると配信を閉じる", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const fake = fakeListener();
      external.openListener.mockImplementation(fake.open);

      yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));

      expect(fake.published.length).toBeGreaterThan(0); // 配信へ到達したうえで
      // 待受けを 1 回だけ閉じ、その前に最後のスナップショットまで渡し切る
      expect(fake.events).toEqual(["drained", "closed"]);
    }));
  });
});
