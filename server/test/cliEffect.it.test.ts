import { defaultClaude } from "../src/modelSelection.ts";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Clock, ConfigProvider, Console, Deferred, Duration, Effect, Fiber, Layer, Predicate, Result } from "effect";
import { CliError } from "effect/cli";
import { HttpServerError } from "effect/http";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, vi } from "vitest";
import { ReviewBuild } from "../src/review.ts";
import { runCli } from "../src/cli.ts";
import { type DiffInput, type Op } from "../src/core/index.ts";
import { fakeListener } from "./fakeListener.ts";
import { dataRows, isUnmeasured, rowOf } from "./fixtures/latencyTable.ts";

const external = vi.hoisted(() => ({ openClaudeUpdater: vi.fn(), openListener: vi.fn(), layerClaude: vi.fn() }));
vi.mock("../src/claude.ts", async () => (await import("./fixtures/claudeModule.ts")).fakeClaudeModule(() => external.openClaudeUpdater(), (model, tuning) => external.layerClaude(model, tuning)));
// 配信の待受け（openListener）だけを偽物にする。serveFeed・portOf は本物のまま
vi.mock("../src/http.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/http.ts")>(),
  openListener: external.openListener,
}));

const fixture = join(import.meta.dirname, "fixtures/short.transcript.json");
const directory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-effect-cli-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

// 登録済みの待ち（sleep）の長さ（ミリ秒）。TestClock に委譲しつつ、目覚めるか中断されるまで一覧に残す。
// TestClock を進める前に、依存する待ち（次の再生待ち）が登録済みであることを状態で確かめるために使う
const trackedClock = (clock: Clock.Clock, pending: number[]): Clock.Clock => ({
  currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
  currentTimeMillis: clock.currentTimeMillis,
  currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
  currentTimeNanos: clock.currentTimeNanos,
  monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: clock.monotonicTimeNanos,
  sleep: (duration) => Effect.suspend(() => {
    const millis = Math.round(Duration.toMillis(duration));
    pending.push(millis);
    return clock.sleep(duration).pipe(Effect.ensuring(Effect.sync(() => {
      const index = pending.indexOf(millis);
      if (index >= 0) pending.splice(index, 1);
    })));
  }),
});

// 登録済みの待ちが expected（順不同）と一致するまで、実時間で確かめ直す。上限に達したらテストを失敗させる
const sleepsRegistered = (pending: readonly number[], expected: readonly number[]) => Effect.gen(function* () {
  const key = (values: readonly number[]) => [...values].sort((x, y) => x - y).join(",");
  for (let i = 0; i < 500; i++) {
    if (key(pending) === key(expected)) return;
    yield* TestClock.withLive(Effect.sleep(10));
  }
  return yield* Effect.die(new Error(`待ちが登録されなかった: 期待 [${expected.join(", ")}]、実際 [${pending.join(", ")}]`));
});

// 受けた依頼（メソッド・パス・本文）を記録し、決めた応答を返す偽の HTTP サーバー。ポートは 0 で待ち受けて実際の番号を返す
interface FakeResponse { readonly status: number; readonly contentType: string; readonly body: string }
const fakeServer = (respond: FakeResponse) => Effect.acquireRelease(
  Effect.callback<{ readonly port: number; readonly requests: { method: string; url: string; body: string }[]; close: () => Promise<void> }>((resume) => {
    const requests: { method: string; url: string; body: string }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({ method: req.method ?? "", url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(respond.status, { "content-type": respond.contentType });
        res.end(respond.body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resume(Effect.succeed({
        port: (server.address() as AddressInfo).port,
        requests,
        close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
      }));
    });
  }),
  (server) => Effect.promise(() => server.close()),
);

function dependencies(sessionsDir: string, port = "12345") {
  const stdout: string[] = [];
  const stderr: string[] = [];
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
    Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed("<!doctype html><html><body></body></html>") })),
  );
  return { layer, stdout, stderr };
}

beforeEach(() => {
  external.openClaudeUpdater.mockReset();
  external.openListener.mockReset();
  external.layerClaude.mockReset();
  external.openClaudeUpdater.mockReturnValue({ update: () => Effect.succeed({ ops: [] }), close: () => {} });
  external.openListener.mockImplementation(fakeListener().open);
});
afterEach(() => vi.restoreAllMocks());

describe("CLI の Effect 境界", () => {
  it.effect("ConfigProvider の保存先と ReviewBuild の Layer が play の最終出力へ届く", () => Effect.gen(function* () {
    const dir = yield* directory;
    const deps = dependencies(dir);
    const calls: string[][] = [];
    external.openClaudeUpdater.mockReturnValue({
      update: (input: DiffInput) => Effect.sync(() => {
        calls.push(input.fresh.map((remark) => remark.id));
        return { ops: [] };
      }),
      close: () => {},
    });
    yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));

    expect(calls).toEqual([["r1"], ["r2"], ["r3"]]);
    expect(external.openListener.mock.calls[0]?.[0]).toBe(12345);
    const paths = deps.stdout.join("").trimEnd().split("\n");
    expect(paths).toHaveLength(4);
    const session = join(paths[0]!, "..");
    expect(session.startsWith(dir)).toBe(true);
    expect(paths).toEqual(["map.md", "map.json", "map.drawnix", "map.html"].map((name) => join(session, name)));
    expect(deps.stdout.join("")).toBe(paths.map((path) => path + "\n").join(""));
  }));

  it.effect("ConfigProvider のポートへ start を送り、本文は app と差分更新のモデルになる", () => Effect.gen(function* () {
    const dir = yield* directory;
    const server = yield* fakeServer({ status: 200, contentType: "application/json", body: JSON.stringify({ dir: join(dir, "run") }) });
    const deps = dependencies(dir, String(server.port));
    yield* runCli(["start", "--app", "zoom.exe"]).pipe(Effect.provide(deps.layer));

    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(`http://127.0.0.1:${server.port}${request!.url}`).toBe(`http://127.0.0.1:${server.port}/session/start`);
    expect(request!.method).toBe("POST");
    expect(JSON.parse(request!.body)).toEqual({ app: "zoom.exe", model: defaultClaude });
    expect(deps.stdout.join("")).toBe(join(dir, "run") + "\n");
  }));

  it.effect("--model を付けると開始の本文の model はそのモデル id になる", () => Effect.gen(function* () {
    const dir = yield* directory;
    const server = yield* fakeServer({ status: 200, contentType: "application/json", body: JSON.stringify({ dir: join(dir, "run") }) });
    const deps = dependencies(dir, String(server.port));
    yield* runCli(["start", "--app", "zoom.exe", "--model", "claude-haiku-5-5"]).pipe(Effect.provide(deps.layer));

    expect(JSON.parse(server.requests[0]!.body)).toEqual({ app: "zoom.exe", model: { ...defaultClaude, model: "claude-haiku-5-5" } });
  }));

  it.effect("2xx 以外の応答は、本文の error をそのまま ServerFailed の 1 行にする", () => Effect.gen(function* () {
    const dir = yield* directory;
    const server = yield* fakeServer({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "すでに録音中です" }) });
    const deps = dependencies(dir, String(server.port));
    const failure = yield* runCli(["stop"]).pipe(Effect.provide(deps.layer), Effect.flip);

    expect(failure).toMatchObject({ _tag: "ServerFailed", message: "すでに録音中です" });
    expect(server.requests.map((request) => `${request.method} ${request.url}`)).toEqual(["POST /session/stop"]);
  }));

  it.effect("2xx 以外で本文が JSON でなくても、状態コードから ServerFailed の 1 行を作る", () => Effect.gen(function* () {
    const dir = yield* directory;
    const server = yield* fakeServer({ status: 500, contentType: "text/plain", body: "boom" });
    const deps = dependencies(dir, String(server.port));
    const failure = yield* runCli(["stop"]).pipe(Effect.provide(deps.layer), Effect.flip);

    expect(failure).toMatchObject({ _tag: "ServerFailed", message: "サーバーがエラーを返しました: 500" });
  }));

  it.effect("2xx 以外で error の無い JSON でも、状態コードから ServerFailed の 1 行を作る", () => Effect.gen(function* () {
    const dir = yield* directory;
    const server = yield* fakeServer({ status: 503, contentType: "application/json", body: "{}" });
    const deps = dependencies(dir, String(server.port));
    const failure = yield* runCli(["status"]).pipe(Effect.provide(deps.layer), Effect.flip);

    expect(failure).toMatchObject({ _tag: "ServerFailed", message: "サーバーがエラーを返しました: 503" });
  }));

  for (const [label, body, expected] of [
    ["JSON でない本文", "not json", "{}\n"],
    ["空本文", "", "{}\n"],
    ["JSON の null", "null", "null\n"],
  ] as const) {
    it.effect(`2xx で ${label} のとき、apps は {} 相当（null は null のまま）を出して成功する`, () => Effect.gen(function* () {
      const dir = yield* directory;
      const server = yield* fakeServer({ status: 200, contentType: "text/plain", body });
      const deps = dependencies(dir, String(server.port));
      yield* runCli(["apps"]).pipe(Effect.provide(deps.layer));

      expect(deps.stdout.join("")).toBe(expected);
    }));
  }

  it.effect("2xx で JSON でない本文の start は、{} のときと同じ文面の ServerFailed になる", () => Effect.gen(function* () {
    const dir = yield* directory;
    const notJson = yield* fakeServer({ status: 200, contentType: "text/plain", body: "not json" });
    const empty = yield* fakeServer({ status: 200, contentType: "application/json", body: "{}" });
    const first = yield* runCli(["start", "--app", "zoom.exe"]).pipe(Effect.provide(dependencies(dir, String(notJson.port)).layer), Effect.flip);
    const second = yield* runCli(["start", "--app", "zoom.exe"]).pipe(Effect.provide(dependencies(dir, String(empty.port)).layer), Effect.flip);

    expect(first).toMatchObject({ _tag: "ServerFailed" });
    expect((first as { message: string }).message.startsWith("サーバーの応答が読めません: ")).toBe(true);
    expect(first).toEqual(second);
  }));

  it.effect("Console と ConfigProvider を提供した export は余分なデータも改行も保持する", () => Effect.gen(function* () {
    const dir = yield* directory;
    const latest = join(dir, "run");
    mkdirSync(latest);
    const exported = { root: { id: "root", kind: "会議", text: "定例", evidence: [], children: [] }, measurement: { seconds: 42 } };
    writeFileSync(join(latest, "export.json"), JSON.stringify(exported));
    const deps = dependencies(dir);
    yield* runCli(["export", "--format", "json"]).pipe(Effect.provide(deps.layer));

    expect(deps.stdout.join("")).toBe(JSON.stringify(exported, null, 2) + "\n");
    expect(deps.stderr).toEqual([]);
  }));

  it.effect.each([
    { name: "JSON 構文", text: "{ not json" },
    { name: "必須キー", text: JSON.stringify({ TODO: [] }) },
    { name: "keywords", text: JSON.stringify({ 決定: [{ from: 1, to: 2, keywords: [] }], TODO: [] }) },
  ])("不正 truth（$name）は defect や CliError ではなくタグ付き失敗として返る", ({ text }) => Effect.gen(function* () {
    const dir = yield* directory;
    const truth = join(dir, "bad.truth.json");
    writeFileSync(truth, text);
    writeFileSync(join(dir, "export.json"), JSON.stringify({ root: { id: "root", kind: "会議", text: "定例", evidence: [], children: [] } }));
    const deps = dependencies(dir);
    const result = yield* Effect.result(runCli(["eval", "--truth", truth, dir]).pipe(Effect.provide(deps.layer)));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    expect(Predicate.hasProperty(result.failure, "_tag")).toBe(true);
    if (!Predicate.hasProperty(result.failure, "_tag")) return;
    expect(typeof result.failure._tag).toBe("string");
    expect(CliError.isCliError(result.failure)).toBe(false);
    expect(deps.stdout).toEqual([]);
    expect(deps.stderr).toEqual([]);
  }));

  it.effect("truth の省略された text を正規化し、keywords と時刻を評価へ渡す", () => Effect.gen(function* () {
    const dir = yield* directory;
    const truth = join(dir, "valid.truth.json");
    writeFileSync(truth, JSON.stringify({ 決定: [], TODO: [{ from: 1, to: 2, keywords: [["求人", "採用"]] }] }));
    writeFileSync(join(dir, "export.json"), JSON.stringify({
      root: { id: "root", kind: "会議", text: "定例", evidence: [], children: [
        { id: "n1", kind: "TODO", text: "採用を進める", evidence: [{ id: "r1", track: "相手", start: 1, end: 2, text: "採用" }], children: [] },
      ] },
    }));
    const deps = dependencies(dir);
    yield* runCli(["eval", "--truth", truth, dir]).pipe(Effect.provide(deps.layer));
    expect(deps.stdout.join("").trimEnd().split("\n").at(-1)).toMatch(/\| 0\/0 \| 1\/1 \(100%\) \| 0 \| 0 \|$/);
    expect(deps.stderr).toEqual([]);
  }));

  it.effect("updater の取得後に配信開始が失敗しても、取得した updater を一度だけ解放する", () => Effect.gen(function* () {
    const dir = yield* directory;
    const deps = dependencies(dir);
    const close = vi.fn();
    external.openClaudeUpdater.mockReturnValue({ update: () => Effect.succeed({ ops: [] }), close });
    external.openListener.mockReturnValue(Effect.fail(new HttpServerError.ServeError({ cause: new Error("配信開始に失敗") })));
    const result = yield* Effect.result(runCli(["play", fixture]).pipe(Effect.provide(deps.layer)));

    expect(external.openClaudeUpdater).toHaveBeenCalledTimes(1);
    expect(external.openListener).toHaveBeenCalledTimes(1);
    expect(Result.isFailure(result)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(deps.stdout).toEqual([]);
  }));

  it.effect("play は、引数なしなら表の調整（medium + adaptive）を layer へ渡す", () => Effect.gen(function* () {
    const dir = yield* directory;
    yield* runCli(["play", fixture]).pipe(Effect.provide(dependencies(dir).layer));

    expect(external.layerClaude.mock.calls).toEqual([[defaultClaude.model, { effort: "medium", thinking: "adaptive" }]]);
  }));

  it.effect("play の --effort と --thinking は、その実行の layer へ届く", () => Effect.gen(function* () {
    const dir = yield* directory;
    yield* runCli(["play", fixture, "--effort", "high", "--thinking", "off"]).pipe(Effect.provide(dependencies(dir).layer));

    expect(external.layerClaude.mock.calls).toEqual([[defaultClaude.model, { effort: "high", thinking: "off" }]]);
  }));

  it.effect("play で --effort だけを渡すと、thinking は表の値のまま（haiku なら low の effort だけが替わる）", () => Effect.gen(function* () {
    const dir = yield* directory;
    yield* runCli(["play", fixture, "--model", "claude-haiku-5-5", "--effort", "high"]).pipe(Effect.provide(dependencies(dir).layer));

    expect(external.layerClaude.mock.calls).toEqual([["claude-haiku-5-5", { effort: "high", thinking: "adaptive" }]]);
  }));

  it.effect("play で渡せない組み合わせ（表に無いモデルの --thinking off）は、待受け・セッション・出力を作る前に UpdaterUnavailable で失敗する", () => Effect.gen(function* () {
    const dir = yield* directory;
    const deps = dependencies(dir);
    const result = yield* Effect.result(runCli(["play", fixture, "--model", "unknown-model", "--thinking", "off"]).pipe(Effect.provide(deps.layer)));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    expect(Predicate.hasProperty(result.failure, "_tag") && result.failure._tag).toBe("UpdaterUnavailable");
    expect(external.layerClaude).not.toHaveBeenCalled();
    expect(external.openClaudeUpdater).not.toHaveBeenCalled();
    expect(external.openListener).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
    expect(deps.stdout).toEqual([]);
  }));

  it.effect.each([
    { name: "effort", args: ["--effort", "extreme"] },
    { name: "thinking", args: ["--thinking", "between_tools"] },
  ])("play の --$name が取りうる値の外なら、何も始めずに失敗する", ({ args }) => Effect.gen(function* () {
    const dir = yield* directory;
    const result = yield* Effect.result(runCli(["play", fixture, ...args]).pipe(Effect.provide(dependencies(dir).layer)));

    expect(Result.isFailure(result)).toBe(true);
    expect(external.layerClaude).not.toHaveBeenCalled();
    expect(external.openListener).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  }));

  it.effect.each([
    { flag: "--thinking", value: "off" },
    { flag: "--effort", value: "high" },
  ])("ライブのセッションを始める start は $flag を受け付けない（ライブは表の調整だけを使う）", ({ flag, value }) => Effect.gen(function* () {
    const dir = yield* directory;
    const server = yield* fakeServer({ status: 200, contentType: "application/json", body: JSON.stringify({ dir: join(dir, "run") }) });
    const result = yield* Effect.result(runCli(["start", "--app", "zoom.exe", flag, value]).pipe(Effect.provide(dependencies(dir, String(server.port)).layer)));

    expect(Result.isFailure(result)).toBe(true);
    expect(server.requests).toEqual([]);
  }));

  it.effect("失敗した更新は記録して公開せず、最終の書き出しまで updater を保持する。失敗した回の待ち時間は待たない", () => Effect.gen(function* () {
    const dir = yield* directory;
    const deps = dependencies(dir);
    const close = vi.fn(() => { expect(deps.stdout.join("")).not.toBe(""); });
    const update = vi.fn((_input: DiffInput) => Effect.suspend(() => {
      expect(close).not.toHaveBeenCalled();
      return update.mock.calls.length === 1
        ? Effect.fail({ _tag: "FakeUpdateFailed", message: "更新に失敗" })
        : Effect.succeed({ ops: [] as Op[] });
    }));
    external.openClaudeUpdater.mockReturnValue({ update, close });
    const { open, published } = fakeListener();
    external.openListener.mockImplementation(open);
    yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));

    // 失敗した回の発言は順番待ちの頭へ戻り、再生の終わり（flush）は再試行の間隔を待たずに戻る
    expect(update).toHaveBeenCalledTimes(1);
    expect(published.map((snapshot) => snapshot.round)).toEqual([0]);
    expect(close).toHaveBeenCalledTimes(1);
    const log = readFileSync(join(deps.stdout.join("").split("\n")[0]!, "..", "log.jsonl"), "utf8");
    expect(log).toContain("更新に失敗");
  }));

  it.effect("realtime は再生間隔だけを TestClock で待ち、発言は届いた時点ですぐ差分更新へ渡る", () => Effect.gen(function* () {
    const dir = yield* directory;
    const deps = dependencies(dir);
    const root = yield* Deferred.make<void>();
    const reflected = yield* Deferred.make<void>();
    const calls: string[][] = [];
    external.openListener.mockImplementation(fakeListener((snapshot) => {
      if (snapshot.round === 0) Deferred.doneUnsafe(root, Effect.void);
    }).open);
    external.openClaudeUpdater.mockReturnValue({
      update: (input: DiffInput) => Effect.sync(() => {
        calls.push(input.fresh.map((remark) => remark.id));
        Deferred.doneUnsafe(reflected, Effect.void);
        return { ops: [] };
      }),
      close: () => {},
    });
    const pending: number[] = [];
    const tracked = yield* TestClock.testClockWith((testClock) => Effect.succeed(trackedClock(testClock, pending)));
    const fiber = yield* runCli(["play", fixture, "--realtime"]).pipe(Effect.provide(deps.layer), Effect.provideService(Clock.Clock, tracked), Effect.forkChild);
    yield* Deferred.await(root);
    yield* sleepsRegistered(pending, [9800]);
    expect(calls).toEqual([]);
    yield* TestClock.adjust(9800);
    yield* Deferred.await(reflected);
    expect(calls).toEqual([["r1"]]);
    yield* sleepsRegistered(pending, [9400]);
    yield* TestClock.adjust(9400);
    yield* sleepsRegistered(pending, [8800]);
    yield* TestClock.adjust(8800);
    yield* Fiber.join(fiber);
    expect(calls).toEqual([["r1"], ["r2"], ["r3"]]);
  }));

  it.effect("realtime の再生は、再生の開始の壁時計を origin の行として最初の発言の前に 1 行だけ残し、latency が同じ形の表を出す", () => Effect.gen(function* () {
    const dir = yield* directory;
    const deps = dependencies(dir);
    const root = yield* Deferred.make<void>();
    external.openListener.mockImplementation(fakeListener((snapshot) => {
      if (snapshot.round === 0) Deferred.doneUnsafe(root, Effect.void);
    }).open);
    const pending: number[] = [];
    const tracked = yield* TestClock.testClockWith((testClock) => Effect.succeed(trackedClock(testClock, pending)));
    const before = Date.now();
    const fiber = yield* runCli(["play", fixture, "--realtime"]).pipe(Effect.provide(deps.layer), Effect.provideService(Clock.Clock, tracked), Effect.forkChild);
    yield* Deferred.await(root);
    yield* sleepsRegistered(pending, [9800]);
    yield* TestClock.adjust(9800);
    yield* sleepsRegistered(pending, [9400]);
    yield* TestClock.adjust(9400);
    yield* sleepsRegistered(pending, [8800]);
    yield* TestClock.adjust(8800);
    yield* Fiber.join(fiber);
    const after = Date.now();

    const session = join(deps.stdout.join("").split("\n")[0]!, "..");
    const log = readFileSync(join(session, "log.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as { type: string; wallTime?: unknown });
    const origins = log.filter((row) => row.type === "origin");
    expect(origins).toHaveLength(1);
    // 壁時計は実時間（TestClock の時刻ではない）。最初の発言より前に書く
    expect(origins[0]!.wallTime).toEqual(expect.any(Number));
    expect(origins[0]!.wallTime as number).toBeGreaterThanOrEqual(before);
    expect(origins[0]!.wallTime as number).toBeLessThanOrEqual(after);
    expect(log.findIndex((row) => row.type === "origin")).toBeLessThan(log.findIndex((row) => row.type === "remark"));

    deps.stdout.length = 0;
    yield* runCli(["latency", session]).pipe(Effect.provide(deps.layer));

    const out = deps.stdout.join("");
    expect(dataRows(out)).toHaveLength(12);
    // 流し直しは settling・取り込み待ちを通らないので、表示・締まり・話者待ちは計測なし。反映・呼び出し待ち・呼び出しには標本がある
    const samples = (track: "自分" | "相手", interval: "applied" | "callWait" | "call") => Number(rowOf(out, track, interval)[2]) || 0; // 標本が無いトラックの件数は計測なし
    const count = (interval: "applied" | "callWait" | "call") => samples("自分", interval) + samples("相手", interval);
    for (const track of ["自分", "相手"] as const) {
      for (const interval of ["shown", "settled", "speakerWait"] as const) expect(isUnmeasured(rowOf(out, track, interval)), `${track} ${interval}`).toBe(true);
    }
    for (const interval of ["applied", "callWait", "call"] as const) expect(count(interval), interval).toBeGreaterThanOrEqual(1);
  }));

  it.effect("realtime でない再生は origin の行を残さず、latency はすべて計測なしと表示する", () => Effect.gen(function* () {
    const dir = yield* directory;
    const deps = dependencies(dir);
    yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));
    const session = join(deps.stdout.join("").split("\n")[0]!, "..");

    expect(readFileSync(join(session, "log.jsonl"), "utf8")).not.toContain('"type":"origin"');
    deps.stdout.length = 0;
    yield* runCli(["latency", session]).pipe(Effect.provide(deps.layer));

    const out = deps.stdout.join("");
    expect(dataRows(out)).toHaveLength(12);
    for (const cells of dataRows(out)) expect(isUnmeasured(cells), cells.join("|")).toBe(true);
  }));
});
