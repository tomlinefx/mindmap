import { defaultClaude } from "../src/modelSelection.ts";
import { DiffUpdatePaused, type DiffUpdateFrame, type DiffUpdater, type Op } from "../src/core/index.ts";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "@effect/vitest";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { ConfigProvider, Console, Deferred, Effect, Exit, Layer, Queue, Ref, Scope, Stream, type Cause } from "effect";
import { TestClock } from "effect/testing";
import { Helpers, HelperLaunchFailure, type HelperExitInfo } from "../src/helpers.ts";
import { runCli } from "../src/cli.ts";
import { buildPrompt } from "../src/claudePrompt.ts";
import { ReviewBuild } from "../src/review.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import { connect } from "./fixtures/wsClient.ts";

const apps = [{ bundleID: "us.zoom.xos", name: "zoom.us" }];

// 偽の Helpers・SessionSinks の Layer を受け取れる新しい入口（server.ts、CT-ENTRY-LAYERS）を通すテスト用の資源。
// resume が諦める／resume の起動中に stop する、といった起動し直しの失敗経路は、fake-helper.ts から
// attempts・listenDelayMs を削った後（CT-FAKE-TRIM）は実物の子プロセスで再現できないため、ここで偽の
// Helpers を使う（要件92）。Origin の拒否・body.audio の 400 は、実物の子プロセスを起動せずに確認できる
// ため、同じ入口を使う（要件97, 98）。
type AttemptScript = {
  connect?: boolean; // 既定 true。false なら接続失敗（HelperLaunchFailure）
  hold?: boolean; // true なら接続を保留する（stop の印が立つまで接続も失敗もしない。実物の「接続待ち」）
  stderrTail?: string[];
  unexpectedExit?: { afterMs: number; exit: HelperExitInfo }; // 自発的な予期せぬ終了
  exitAfterStop?: HelperExitInfo; // stop が呼ばれたときの終わり方（既定 SIGTERM）
  events?: unknown[]; // 接続した直後にヘルパーが流すイベント（JSON にして events の Stream に載せる）
};

const makeFakeHelpers = (attempts: AttemptScript[], permission: { microphone: "authorized" | "denied" | "notDetermined" } = { microphone: "authorized" }) => {
  const calls: string[][] = [];
  const checks: boolean[] = [];
  const sent: boolean[] = []; // server から helper へ送られた休止の指示（paused の値を届いた順に）
  const check = Effect.sync(() => {
    checks.push(true);
    return { microphone: permission.microphone, sttModel: "installed" as const };
  });
  const launch = (args: ReadonlyArray<string>, stopRequested: Deferred.Deferred<void>) =>
    Effect.gen(function* () {
      const index = calls.length;
      calls.push([...args]);
      const script = attempts[Math.min(index, attempts.length - 1)] ?? {};
      if (script.connect === false) return yield* new HelperLaunchFailure({ stderrTail: script.stderrTail ?? [] });
      if (script.hold) {
        yield* Deferred.await(stopRequested); // 止めて、の印で、ヘルパーが止まって接続待ちが失敗する
        return yield* new HelperLaunchFailure({ stderrTail: [], exit: { code: null, signal: "SIGTERM" } });
      }
      const queue = yield* Queue.make<unknown, Cause.Done>();
      for (const event of script.events ?? []) Queue.offerUnsafe(queue, JSON.stringify(event));
      const exitDeferred = yield* Deferred.make<HelperExitInfo>();
      const stoppedRef = yield* Ref.make(false);
      if (script.unexpectedExit) {
        yield* Effect.forkScoped(Effect.gen(function* () {
          yield* Effect.sleep(script.unexpectedExit!.afterMs);
          const already = yield* Ref.getAndSet(stoppedRef, true);
          if (already) return;
          yield* Queue.end(queue);
          yield* Deferred.succeed(exitDeferred, script.unexpectedExit!.exit);
        }));
      }
      const stop = Effect.gen(function* () {
        const already = yield* Ref.getAndSet(stoppedRef, true);
        if (already) return;
        yield* Queue.end(queue);
        yield* Deferred.succeed(exitDeferred, script.exitAfterStop ?? { code: null, signal: "SIGTERM" });
      });
      yield* Effect.addFinalizer(() => Effect.ignore(stop));
      return { events: Stream.fromQueue(queue) as Stream.Stream<string>, stop, exit: Deferred.await(exitDeferred), stderrTail: Effect.succeed(script.stderrTail ?? []), send: (instruction: { type: string; paused: boolean }) => Effect.sync(() => { if (instruction.type === "self-pause") sent.push(instruction.paused); }) };
    });
  return { helpers: Helpers.of({ apps: Effect.succeed(apps), check, launch }), calls, checks, sent };
};

const resourceWithFakeHelpers = Effect.fnUntraced(function* (attempts: AttemptScript[], options: { updaterLayer?: () => Layer.Layer<DiffUpdater>; permission?: { microphone: "authorized" | "denied" | "notDetermined" } } = {}) {
  const dir = yield* Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-http-fake-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const sessionsDir = join(dir, "sessions");
  const fakeHelpers = makeFakeHelpers(attempts, options.permission);
  const sessionSinksLayer = SessionSinks.layer({
    prepareUpdater: () => Effect.succeed(options.updaterLayer ? options.updaterLayer() : updaterLayer(() => Effect.succeed({ ops: [] }))),
  }).pipe(Layer.provide(fakeExportServices()));
  const server = yield* startedServer(
    { port: 0, viewPort: 0, sessionsDir },
    { helpers: Layer.succeed(Helpers)(fakeHelpers.helpers), sessionSinks: sessionSinksLayer, viewing: fakeExportServices() },
  );
  return {
    server, calls: fakeHelpers.calls, checks: fakeHelpers.checks, sent: fakeHelpers.sent, sessionsDir,
    request: (method: string, path: string, body: string | undefined, origin: string | undefined) => fetch(
      `http://127.0.0.1:${server.port}${path}`,
      { method, headers: { "content-type": "application/json", ...(origin === undefined ? {} : { origin }) }, ...(body === undefined ? {} : { body }) },
    ),
  };
});

describe("HTTP の失敗応答（要件8〜11）", () => {
  it.effect("同じライブセッションの一時停止・再開・終了が接続中と再接続の画面へ届く", () => Effect.gen(function* () {
    let calls = 0;
    const r = yield* resourceWithFakeHelpers([{ events: [
      { type: "speaker-off", start: 0, reason: "モデルなし" }, // 相手の発言は話者の確定を待つので、話者分離を使えない helper にして待たせない（Issue #1021）
      { type: "remark", track: "相手", start: 0, end: 1, text: "最初の発言" },
      { type: "remark", track: "相手", start: 1, end: 2, text: "次の発言" },
    ] }], { updaterLayer: () => updaterLayer(() => Effect.suspend(() => {
      calls++;
      return calls === 1 ? Effect.fail(new DiffUpdatePaused({ reason: "ChatGPT の利用上限", message: "合成の利用上限" })) : Effect.succeed({ ops: [] });
    })) });
    const firstScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void));
    const first = yield* connect(r.server.port, "/ws", undefined).pipe(Scope.provide(firstScope));
    const frames = (all: unknown[]) => all.filter((f): f is DiffUpdateFrame => typeof f === "object" && f !== null && "type" in f && f.type === "diff-update");
    const wait = (all: unknown[], state: DiffUpdateFrame["state"]) => Effect.tryPromise(() => vi.waitFor(() => expect(frames(all).at(-1)?.state).toEqual(state)));
    expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos"}', undefined))).status).toBe(200);
    const paused = { status: "paused", reason: "ChatGPT の利用上限" } as const;
    yield* wait(first.frames, paused);
    expect(frames(first.frames).map((f) => f.state)).toEqual([{ status: "running" }, paused]);
    yield* Scope.close(firstScope, Exit.void);
    const reconnected = yield* connect(r.server.port, "/ws", undefined);
    yield* wait(reconnected.frames, paused);
    yield* TestClock.adjust(300_000);
    yield* wait(reconnected.frames, { status: "running" });
    expect(calls).toBe(2);
    expect((yield* Effect.tryPromise(() => r.request("POST", "/session/stop", undefined, undefined))).status).toBe(200);
    yield* wait(reconnected.frames, null);
    const after = yield* connect(r.server.port, "/ws", undefined);
    yield* wait(after.frames, null);
    expect(frames(after.frames)).toEqual([{ type: "diff-update", state: null }]);
  }));
  // map-update-latency 6.4: 取り込み待ちのフレームは最後の 1 つを保持し、後からつないだ画面にも送る。項目が無くなった後・セッションが終わった後につないだ画面には送らない
  describe("取り込み待ちのフレームの保持（map-update-latency 6.4）", () => {
    const pendingFrames = (all: unknown[]) => all.filter((f): f is { type: "pending-remarks"; remarks: Array<{ state: string; text: string; key: string }> } => typeof f === "object" && f !== null && "type" in f && f.type === "pending-remarks");
    const SPEAKER_OFF_EVENT = { type: "speaker-off", start: 0, reason: "モデルなし" };

    it.live("反映中の発言があるとき、後からつないだ画面にも取り込み待ちのフレームが届く。反映が済んで空のフレームが出た後につないだ画面には届かない", () => Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const r = yield* resourceWithFakeHelpers([{ events: [SPEAKER_OFF_EVENT, { type: "remark", track: "相手", start: 0, end: 1, text: "反映待ちの発言" }] }], {
        updaterLayer: () => updaterLayer(() => Effect.as(Deferred.await(gate), { ops: [] })),
      });
      const early = yield* connect(r.server.port, "/ws", undefined);
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos"}', undefined))).status).toBe(200);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(pendingFrames(early.frames).at(-1)?.remarks.map((x) => [x.state, x.text])).toEqual([["reflecting", "反映待ちの発言"]]), { timeout: 10_000 }));

      const late = yield* connect(r.server.port, "/ws", undefined);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(pendingFrames(late.frames).map((f) => f.remarks.map((x) => [x.state, x.text]))).toEqual([[["reflecting", "反映待ちの発言"]]])));

      yield* Deferred.succeed(gate, undefined);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(pendingFrames(early.frames).at(-1)?.remarks).toEqual([]), { timeout: 10_000 }));
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(pendingFrames(late.frames).at(-1)?.remarks).toEqual([])));
      const after = yield* connect(r.server.port, "/ws", undefined);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(after.frames.length).toBeGreaterThan(0))); // 保持している他のフレームは届く
      yield* Effect.tryPromise(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
      expect(pendingFrames(after.frames)).toEqual([]);
    }));

    it.live("セッションを終えた後につないだ画面には、終える前に項目が残っていた取り込み待ちのフレームが届かない", () => Effect.gen(function* () {
      let calls = 0;
      const r = yield* resourceWithFakeHelpers([{ events: [SPEAKER_OFF_EVENT, { type: "remark", track: "相手", start: 0, end: 1, text: "取り込めない発言" }] }], {
        updaterLayer: () => updaterLayer(() => Effect.suspend(() => {
          calls++;
          return Effect.fail(new DiffUpdatePaused({ reason: "ChatGPT の利用上限", message: "合成の利用上限" }));
        })),
      });
      const viewer = yield* connect(r.server.port, "/ws", undefined);
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos"}', undefined))).status).toBe(200);
      yield* Effect.tryPromise(() => vi.waitFor(() => {
        expect(calls).toBe(1);
        expect(pendingFrames(viewer.frames).at(-1)?.remarks.map((x) => x.text)).toEqual(["取り込めない発言"]); // 終える前は項目が残っている
      }, { timeout: 10_000 }));

      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/stop", undefined, undefined))).status).toBe(200);
      const after = yield* connect(r.server.port, "/ws", undefined);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(after.frames.length).toBeGreaterThan(0)));
      yield* Effect.tryPromise(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
      expect(pendingFrames(after.frames)).toEqual([]);
    }));
  });

  // map-update-latency 4.2: 壁時計つきの origin と speaker-off を流す偽のヘルパーで、相手の発言が保留に止まらず差分更新へ届く（本物の Sessions・SessionSinks を通す）
  it.live("壁時計つきの origin と speaker-off の後の相手の発言は、待たずに差分更新へ届く", () => Effect.gen(function* () {
    const fresh: string[] = [];
    const r = yield* resourceWithFakeHelpers([{ events: [
      { type: "origin", hostTime: "1000", wallTime: Date.now() },
      { type: "speaker-off", start: 0, reason: "モデルなし" },
      { type: "remark", track: "相手", start: 0, end: 1, text: "待たずに届く発言" },
    ] }], { updaterLayer: () => updaterLayer((input) => Effect.sync(() => {
      fresh.push(...input.fresh.map((remark) => remark.text));
      return { ops: [] };
    })) });
    expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos"}', undefined))).status).toBe(200);
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(fresh).toEqual(["待たずに届く発言"]), { timeout: 10_000 }));
  }));

  // map-update-latency 7.1: 偽のヘルパーでセッションを開いて閉じると、log.jsonl に origin の行（最初の wallTime だけ）と、各発言の settledAt・shownAt が残る
  describe("計測のためのログ（map-update-latency 7.1）", () => {
    const openAndStop = Effect.fnUntraced(function* (events: unknown[]) {
      const fresh: string[] = [];
      const r = yield* resourceWithFakeHelpers([{ events }], { updaterLayer: () => updaterLayer((input) => Effect.sync(() => {
        fresh.push(...input.fresh.map((remark) => remark.text));
        return { ops: [] };
      })) });
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos"}', undefined))).status).toBe(200);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(fresh).toEqual(["ひとつめ", "ふたつめ"]), { timeout: 10_000 }));
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/stop", undefined, undefined))).status).toBe(200);
      const [dir] = (yield* Effect.tryPromise(() => readdir(r.sessionsDir, { withFileTypes: true }))).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      const text = yield* Effect.tryPromise(() => readFile(join(r.sessionsDir, dir!, "log.jsonl"), "utf8"));
      return text.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { type: string; wallTime?: number; at?: string; settledAt?: unknown; shownAt?: unknown });
    });
    const remarks = [
      { type: "remark", track: "相手", start: 0, end: 1, text: "ひとつめ" },
      { type: "remark", track: "相手", start: 2, end: 3, text: "ふたつめ" },
    ];

    it.live("wallTime つきの origin が起動し直しで 2 回届いても、origin の行は最初の wallTime の 1 行だけ。各発言の行に settledAt と shownAt が数値で付く", () => Effect.gen(function* () {
      const lines = yield* openAndStop([
        { type: "origin", hostTime: "1000", wallTime: 1760000000000 },
        { type: "speaker-off", start: 0, reason: "モデルなし" },
        { type: "origin", hostTime: "2000", wallTime: 1760000005000 },
        ...remarks,
      ]);
      const origins = lines.filter((l) => l.type === "origin");
      expect(origins).toHaveLength(1);
      expect(origins[0]).toMatchObject({ wallTime: 1760000000000 });
      expect(typeof origins[0]!.at).toBe("string");
      const rows = lines.filter((l) => l.type === "remark");
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(typeof row.settledAt).toBe("number");
        expect(typeof row.shownAt).toBe("number");
      }
    }));

    it.live("wallTime の無い origin では origin の行を書かない。発言の行の settledAt は付く", () => Effect.gen(function* () {
      const lines = yield* openAndStop([
        { type: "origin", hostTime: "1000" },
        { type: "speaker-off", start: 0, reason: "モデルなし" },
        ...remarks,
      ]);
      expect(lines.filter((l) => l.type === "origin")).toHaveLength(0);
      const rows = lines.filter((l) => l.type === "remark");
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(typeof row.settledAt).toBe("number");
    }));
  });

  // 偽の Helpers の Layer（新しい入口、CT-ENTRY-LAYERS）を使う。fake-helper.ts から attempts・listenDelayMs を
  // 削った後（CT-FAKE-TRIM）は、この 2 本を実物の子プロセスで再現できない（要件92）。期待値は変えない。
  // 1 回目（start の初回起動）は接続してから予期せず終わる（続けて失敗した回に数える）。2・3 回目の失敗で諦める
  const firstAttemptExits: AttemptScript = { unexpectedExit: { afterMs: 50, exit: { code: 1, signal: null } } };
  const giveUpAttempts: AttemptScript[] = [
    { connect: false, stderrTail: ["初回の再起動失敗"] },
    { connect: false, stderrTail: ["初回の再起動失敗"] },
  ];
  it.live("resumeが再起動を諦めると503で最後のstderrを返す", () =>
    Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([
        firstAttemptExits,
        ...giveUpAttempts, // 2・3 回目の失敗で諦める
        { connect: false, stderrTail: ["途中の失敗"] },
        { connect: false, stderrTail: ["途中の失敗"] },
        { connect: false, stderrTail: ["最後の失敗"] },
      ]);
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos"}', undefined))).status).toBe(200);
      yield* Effect.tryPromise(() => vi.waitFor(async () => {
        const response = await r.request("GET", "/session/status", undefined, undefined);
        expect(await response.json()).toMatchObject({ status: "stopped" });
      }, { timeout: 10_000 }));
      const response = yield* Effect.tryPromise(() => r.request("POST", "/session/resume", undefined, undefined));
      expect(response.status).toBe(503);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: "起動し直しに失敗しました: 最後の失敗" });
    }));
  it.live("resumeの起動中にstopすると503で中断を返す", () =>
    Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([firstAttemptExits, ...giveUpAttempts, { hold: true }]); // resume の起動し直しは接続待ちのまま止める
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos"}', undefined))).status).toBe(200);
      yield* Effect.tryPromise(() => vi.waitFor(async () => {
        const response = await r.request("GET", "/session/status", undefined, undefined);
        expect(await response.json()).toMatchObject({ status: "stopped" });
      }, { timeout: 10_000 }));
      const resuming = r.request("POST", "/session/resume", undefined, undefined);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(r.calls).toHaveLength(4), { timeout: 10_000 }));
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/stop", undefined, undefined))).status).toBe(200);
      const response = yield* Effect.tryPromise(() => resuming);
      expect(response.status).toBe(503);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: "中断されました" });
    }));
});

describe("新しい入口（偽の Helpers・SessionSinks を受け取れるサーバー。CT-ENTRY-LAYERS）", () => {
  it.live("非ローカル Origin の start は403で拒否され、ヘルパーを起動しない", () =>
    Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([{}]);
      const response = yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos"}', "https://evil.example"));
      expect(response.status).toBe(403);
      expect(r.calls).toHaveLength(0);
    }));

  it.live("ヘルパーが接続する前に終わると start は500で、終わった理由の文面を返し、セッションは開始されない（HelperExited）", () =>
    Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([{ connect: false, stderrTail: ["マイクが許可されていません"] }]);
      const response = yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos"}', undefined));
      expect(response.status).toBe(500);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({ error: "ヘルパーが終了しました（null）: マイクが許可されていません" });
      const status = yield* Effect.tryPromise(() => r.request("GET", "/session/status", undefined, undefined));
      expect(yield* Effect.tryPromise(() => status.json())).toMatchObject({ status: "none" });
    }));

  // base の server.heavy.test.ts「開始に失敗しても、接続中のクライアントにも新しく接続したクライアントにも、空のマップは届かず…」の移動先。
  // 実物の SessionSinks・Viewers・/ws を通す。sessions.ts が sinks.open を helpers.launch より前に動かす、
  // または失敗時に viewers.publish を呼ぶと、before/after が「失敗」のマップを受け取りこのテストは落ちる。
  // base の値（4 ノード・子の文面）は実物 fake-helper の台本と updater から決まっていた。偽 Helpers はイベントを
  // 送らず updater は ops: [] なので root だけになる（[[1,"前"],[1,"次"]]）。守る不変条件（失敗の前後で
  // スナップショットが増えない・新しいクライアントには前のセッションの最後のマップが届く）は同じ
  it.live("開始に失敗しても、接続中のクライアントにも新しく接続したクライアントにも、空のマップは届かず、前のセッションの最後のマップが残る", () =>
    Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([{}, { connect: false, stderrTail: ["マイクが許可されていません"] }, {}]);
      const post = (path: string, body?: string) => Effect.tryPromise(() => r.request("POST", path, body, undefined));
      type Snap = { nodes: { text: string }[] };
      const snapshots = (frames: unknown[]) => frames.filter((f) => !(typeof f === "object" && f !== null && "type" in f)) as Snap[];
      const waitCount = (frames: unknown[], n: number) => Effect.tryPromise(() => vi.waitFor(() => expect(snapshots(frames)).toHaveLength(n)));

      expect((yield* post("/session/start", '{"app":"us.zoom.xos","title":"前"}')).status).toBe(200);
      expect((yield* post("/session/stop")).status).toBe(200);
      const before = yield* connect(r.server.port, "/ws", undefined);
      yield* waitCount(before.frames, 1);

      const failed = yield* post("/session/start", '{"app":"us.zoom.xos","title":"失敗"}');
      expect(failed.status).toBe(500);
      expect(yield* Effect.tryPromise(() => failed.json())).toEqual({ error: "ヘルパーが終了しました（null）: マイクが許可されていません" });

      const after = yield* connect(r.server.port, "/ws", undefined);
      yield* waitCount(after.frames, 1);
      expect(snapshots(after.frames)[0]!.nodes.map((n) => n.text)).toEqual(["前"]);

      expect((yield* post("/session/start", '{"app":"us.zoom.xos","title":"次"}')).status).toBe(200);
      expect((yield* post("/session/stop")).status).toBe(200);
      yield* waitCount(before.frames, 2);
      expect(snapshots(before.frames).map((s) => [s.nodes.length, s.nodes[0]!.text])).toEqual([[1, "前"], [1, "次"]]);
      expect(snapshots(after.frames).map((s) => s.nodes[0]!.text)).toEqual(["前", "次"]);
    }));

  // base の server.heavy.test.ts「cli status が…」の配線部分（cli.ts の status → GET /session/status → formatIntakeStatus → 標準出力）の移動先
  it.live("cli status が、セッションなし・動いている・stop 後の状態を、サーバーの応答から標準出力へ値として出す", () =>
    Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([{}]);
      // 接続先ポートと保存先は ConfigProvider、標準出力は Console で渡す（cli.ts の入口と同じ Service）
      const status = () => Effect.suspend(() => {
        const out: string[] = [];
        const consoleService: Console.Console = {
          ...console,
          log: (...args: unknown[]) => { out.push(args.map(String).join(" ") + "\n"); },
        };
        const cliLayer = Layer.mergeAll(
          NodeServices.layer,
          NodeHttpClient.layerUndici,
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LIVE_MINDMAP_SESSIONS: r.sessionsDir, LIVE_MINDMAP_PORT: String(r.server.port) })),
          Layer.succeed(Console.Console, consoleService),
          Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed("") })),
        );
        return runCli(["status"]).pipe(Effect.provide(cliLayer), Effect.map(() => out.join("")));
      });
      expect(yield* status()).toBe("セッションなし\n閲覧の共有: 無し\n");
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos","title":"週次"}', undefined))).status).toBe(200);
      const [dir] = (yield* Effect.tryPromise(() => readdir(r.sessionsDir, { withFileTypes: true }))).filter((entry) => entry.isDirectory()).map((entry) => entry.name); // 語彙の溜まりのファイルは除く
      const running = yield* status();
      expect(running).toContain("動いている");
      expect(running).toContain(dir!);
      expect(running).toContain("起動し直した回数: 0");
      expect(running).not.toContain("最後の途切れの時刻");
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/stop", undefined, undefined))).status).toBe(200);
      // 通常の stop の後は none に戻る。「止まった」（諦めた状態）の文面は intake.test.ts、状態の値は sessions.test.ts が観測する
      expect(yield* status()).toBe("セッションなし\n閲覧の共有: 無し\n");
    }));

  describe("自分の休止（POST /session/self-pause）", () => {
    const selfPause = (r: { request: (m: string, p: string, b: string | undefined, o: string | undefined) => Promise<Response> }, body: string | undefined) =>
      Effect.tryPromise(() => r.request("POST", "/session/self-pause", body, undefined));

    it.live("セッション中に {paused:true} を送ると 204 になり、helper へ休止の指示が届く。{paused:false} で再開の指示が届く", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{}]);
        expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos"}', undefined))).status).toBe(200);

        expect((yield* selfPause(r, '{"paused":true}')).status).toBe(204);
        expect(r.sent).toEqual([true]);
        expect((yield* selfPause(r, '{"paused":false}')).status).toBe(204);
        expect(r.sent).toEqual([true, false]);
      }));

    for (const body of ['{}', '{"paused":"true"}', '{"paused":1}', '{"paused":true,"extra":1}', "not json", undefined]) {
      it.live(`本文が ${String(body)} なら 400 で拒否し、helper へ何も送らない`, () =>
        Effect.gen(function* () {
          const r = yield* resourceWithFakeHelpers([{}]);
          yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos"}', undefined));

          expect((yield* selfPause(r, body)).status).toBe(400);
          expect(r.sent).toEqual([]);
        }));
    }

    it.live("セッションが無いときは 409 で、helper へ何も送らない", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{}]);
        expect((yield* selfPause(r, '{"paused":true}')).status).toBe(409);
        expect(r.sent).toEqual([]);
      }));

    it.live("非ローカル Origin からは 403 で拒否し、helper へ何も送らない", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{}]);
        yield* Effect.tryPromise(() => r.request("POST", "/session/start", '{"app":"us.zoom.xos"}', undefined));
        const response = yield* Effect.tryPromise(() => r.request("POST", "/session/self-pause", '{"paused":true}', "https://evil.example"));
        expect(response.status).toBe(403);
        expect(r.sent).toEqual([]);
      }));
  });

  // Issue #1026: 話者の名前（POST /session/speaker-name）。ラベルは、ヘルパーの speaker と発言で振られたものだけ
  describe("話者の名前（POST /session/speaker-name）", () => {
    type Requester = { request: (m: string, p: string, b: string | undefined, o: string | undefined) => Promise<Response> };
    const START = '{"app":"us.zoom.xos"}';
    const speakerName = (r: Requester, body: string | undefined, origin?: string) => Effect.tryPromise(() => r.request("POST", "/session/speaker-name", body, origin));
    const nameBody = (label: string, name: string) => JSON.stringify({ label, name });
    // 相手の 2 人が 1 発言ずつ話す台本（相手 A・相手 B が振られる）。start で一度に流れる
    const twoSpeakers = (start: number): unknown[] => [0, 1].flatMap((slot) => [
      { type: "speaker", track: "相手", start: start + slot * 2, end: start + slot * 2 + 2, slot, final: true },
      { type: "speaker-settled", track: "相手", to: start + slot * 2 + 2 },
      { type: "remark", track: "相手", start: start + slot * 2, end: start + slot * 2 + 2, text: `発言${slot + 1}です` },
    ]);
    // 振られるまで待って名前を付ける（振る前は 4xx で断られるので、204 になるまで繰り返す）
    const nameWhenLabeled = (r: Requester, label: string, name: string) => Effect.tryPromise(() => vi.waitFor(async () => {
      expect((await r.request("POST", "/session/speaker-name", nameBody(label, name), undefined)).status).toBe(204);
    }, { timeout: 10_000 }));
    const names = (frames: unknown[]) => frames
      .filter((f): f is { type: "speaker-names"; names: Array<{ label: string; name: string }> } => typeof f === "object" && f !== null && "type" in f && f.type === "speaker-names")
      .map((f) => f.names);
    const logLines = (dir: string) => Effect.tryPromise(async () => (await readFile(join(dir, "log.jsonl"), "utf8")).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { type: string; label?: string; name?: string; source?: string; at?: string }));

    it.live("振られたラベルに {label,name} を送ると 204 になり、log.jsonl に手入力の名前が残り、つないでいる画面へ名前のフレームが届く", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{ events: twoSpeakers(0) }]);
        const started = yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined));
        const { dir } = (yield* Effect.tryPromise(() => started.json())) as { dir: string };
        const viewer = yield* connect(r.server.port, "/ws", undefined);

        yield* nameWhenLabeled(r, "相手 B", "田中");

        yield* Effect.tryPromise(() => vi.waitFor(() => expect(names(viewer.frames).at(-1)).toEqual([{ label: "相手 B", name: "田中" }])));
        const lines = (yield* logLines(dir)).filter((l) => l.type === "speaker-name");
        expect(lines.map(({ at, ...rest }) => ({ hasAt: typeof at === "string", rest }))).toEqual([{ hasAt: true, rest: { type: "speaker-name", label: "相手 B", name: "田中", source: "手入力" } }]);
      }));

    it.live("後からつないだ画面にも、いまの名前が（最初のフレームとして）届く", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{ events: twoSpeakers(0) }]);
        yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined));
        yield* nameWhenLabeled(r, "相手 A", "鈴木");

        const late = yield* connect(r.server.port, "/ws", undefined);

        yield* Effect.tryPromise(() => vi.waitFor(() => expect(names(late.frames)).toEqual([[{ label: "相手 A", name: "鈴木" }]])));
      }));

    it.live("自分・まだ振られていないラベル・ラベルの無い「相手」・空の名前は 4xx で断り、log.jsonl にも画面のフレームにも何も出ない", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{ events: twoSpeakers(0) }]);
        const started = yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined));
        const { dir } = (yield* Effect.tryPromise(() => started.json())) as { dir: string };
        const viewer = yield* connect(r.server.port, "/ws", undefined);
        yield* nameWhenLabeled(r, "相手 A", "鈴木"); // 振られた後の状態で、断られることを示す
        yield* Effect.tryPromise(() => vi.waitFor(() => expect(names(viewer.frames).at(-1)).toEqual([{ label: "相手 A", name: "鈴木" }])));
        const before = names(viewer.frames).length;

        for (const [label, name] of [["自分", "田中"], ["相手 C", "田中"], ["相手", "田中"], ["相手 A", ""], ["相手 A", "   "]] as const) {
          const response = yield* speakerName(r, nameBody(label, name));
          expect([label, name, response.status >= 400 && response.status < 500]).toEqual([label, name, true]);
        }

        expect((yield* logLines(dir)).filter((l) => l.type === "speaker-name").map((l) => [l.label, l.name])).toEqual([["相手 A", "鈴木"]]); // 最初に付けた 1 件だけ
        yield* Effect.tryPromise(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
        expect(names(viewer.frames)).toHaveLength(before);
        expect(names(viewer.frames).at(-1)).toEqual([{ label: "相手 A", name: "鈴木" }]); // 空の名前で外れていない
      }));

    for (const body of ['{}', '{"label":"相手 A"}', '{"name":"田中"}', '{"label":1,"name":"田中"}', '{"label":"相手 A","name":2}', '{"label":"相手 A","name":"田中","extra":1}', "not json", undefined]) {
      it.live(`本文が ${String(body)} なら 400 で拒否し、名前を付けない`, () =>
        Effect.gen(function* () {
          const r = yield* resourceWithFakeHelpers([{ events: twoSpeakers(0) }]);
          const started = yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined));
          const { dir } = (yield* Effect.tryPromise(() => started.json())) as { dir: string };
          yield* nameWhenLabeled(r, "相手 B", "先に付けた名前"); // 振られた後でも、本文が違えば 400（振られていないことによる 4xx と区別する）

          expect((yield* speakerName(r, body)).status).toBe(400);

          expect((yield* logLines(dir)).filter((l) => l.type === "speaker-name")).toHaveLength(1);
        }));
    }

    it.live("セッションが無いときは 409", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{}]);
        expect((yield* speakerName(r, nameBody("相手 A", "田中"))).status).toBe(409);
      }));

    it.live("非ローカル Origin からは 403 で拒否し、名前を付けない", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{ events: twoSpeakers(0) }]);
        const started = yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined));
        const { dir } = (yield* Effect.tryPromise(() => started.json())) as { dir: string };
        yield* nameWhenLabeled(r, "相手 A", "先に付けた名前");

        expect((yield* speakerName(r, nameBody("相手 B", "田中"), "https://evil.example")).status).toBe(403);

        expect((yield* logLines(dir)).filter((l) => l.type === "speaker-name").map((l) => l.label)).toEqual(["相手 A"]);
      }));

    // cli resume は同じセッションのヘルパーを起動し直すだけ。名前はサーバーのメモリに残り、起動し直した後の差分更新にも使われる
    it.live("取り込みが止まって resume しても名前が残る。resume の後の差分更新の直前の発言の行は 相手 B（田中）、新しくつないだ画面にも名前が届く", () =>
      Effect.gen(function* () {
        const prompts: string[][] = [];
        const r = yield* resourceWithFakeHelpers([
          { events: twoSpeakers(0), unexpectedExit: { afterMs: 1500, exit: { code: 1, signal: null } } },
          { connect: false }, { connect: false }, // 2・3 回目の失敗で諦めて止まる
          { events: [{ type: "speaker-off", start: 0, reason: "モデルなし" }, { type: "remark", track: "相手", start: 10, end: 12, text: "再開後の発言です" }] },
        ], { updaterLayer: () => updaterLayer((input) => Effect.sync(() => {
          prompts.push(buildPrompt(input).split("\n").filter((line) => /^r\d+ /.test(line)));
          return { ops: [] };
        })) });
        expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined))).status).toBe(200);
        yield* nameWhenLabeled(r, "相手 B", "田中");
        yield* Effect.tryPromise(() => vi.waitFor(async () => {
          expect(await (await r.request("GET", "/session/status", undefined, undefined)).json()).toMatchObject({ status: "stopped" });
        }, { timeout: 10_000 }));

        expect((yield* Effect.tryPromise(() => r.request("POST", "/session/resume", undefined, undefined))).status).toBe(204);

        yield* Effect.tryPromise(() => vi.waitFor(() => {
          expect(prompts.flat().some((line) => line.includes("再開後の発言です"))).toBe(true);
        }, { timeout: 10_000 }));
        const afterResume = prompts.find((lines) => lines.some((line) => line.includes("再開後の発言です")))!;
        expect(afterResume.filter((line) => line.includes("発言2です"))).toEqual(["r2 [00:02] 相手 B（田中）: 発言2です"]);
        const reconnected = yield* connect(r.server.port, "/ws", undefined);
        yield* Effect.tryPromise(() => vi.waitFor(() => expect(names(reconnected.frames).at(-1)).toEqual([{ label: "相手 B", name: "田中" }])));
        // resume の後も、振ったラベルには名前を付けられる（ラベルの状態も残っている）
        expect((yield* speakerName(r, nameBody("相手 A", "鈴木"))).status).toBe(204);
      }));

    // Issue #1028 AC4: 偽のヘルパー＋偽の AI で、HTTP の start → 名前付け → stop を通し、書き出した map.md / map.json に人と名前が載る
    it.live("start → 名前付け → stop の後、map.md は名前を付けたラベルを名前で・付けないラベルをラベルのまま出し、map.json のノードはラベルのまま、ルートに対応表が載る", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{ events: twoSpeakers(0) }], { updaterLayer: () => updaterLayer((input) => Effect.sync(() => ({
          ops: input.fresh.flatMap((remark): Op[] => {
            if (remark.text.includes("発言1です")) return [{ op: "add", ref: "p1", parent: "root", kind: "案", text: "週 1", evidence: [remark.id] }];
            if (remark.text.includes("発言2です")) return [
              { op: "add", ref: "p2", parent: "root", kind: "案", text: "隔週", evidence: [remark.id] },
              { op: "add", ref: "p3", parent: "root", kind: "TODO", text: "資料を送る", evidence: [remark.id], assigneeSpeaker: "相手 B" },
            ];
            return [];
          }),
        }))) });
        const started = yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined));
        expect(started.status).toBe(200);
        const { dir } = (yield* Effect.tryPromise(() => started.json())) as { dir: string };
        yield* nameWhenLabeled(r, "相手 B", "田中"); // 相手 A には名前を付けない

        expect((yield* Effect.tryPromise(() => r.request("POST", "/session/stop", undefined, undefined))).status).toBe(200);

        const md = yield* Effect.tryPromise(() => readFile(join(dir, "map.md"), "utf8"));
        const lines = md.split("\n");
        expect(lines).toContain("- 週 1 — 相手 A（00:00）");
        expect(lines).toContain("- 隔週 — 田中（00:02）");
        expect(lines.filter((l) => l === "- 資料を送る（担当：田中）（00:02）")).toHaveLength(2); // 冒頭の TODO 一覧とアウトライン
        expect(md).not.toContain("相手 B");
        const out = JSON.parse(yield* Effect.tryPromise(() => readFile(join(dir, "map.json"), "utf8"))) as { speakerNames?: unknown; root: { children: Array<{ text: string }> } };
        expect(out.speakerNames).toEqual({ "相手 B": "田中" });
        const byText = (text: string) => out.root.children.find((c) => c.text === text);
        expect(byText("週 1")).toMatchObject({ proposer: "相手 A" });
        expect(byText("隔週")).toMatchObject({ proposer: "相手 B" });
        expect(byText("資料を送る")).toMatchObject({ assigneeSpeaker: "相手 B" });
      }));

    it.live("セッションを終えて新しく start すると、名前は持ち越されない（画面へ届く表は空）", () =>
      Effect.gen(function* () {
        const r = yield* resourceWithFakeHelpers([{ events: twoSpeakers(0) }, { events: twoSpeakers(0) }]);
        yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined));
        yield* nameWhenLabeled(r, "相手 A", "田中");
        expect((yield* Effect.tryPromise(() => r.request("POST", "/session/stop", undefined, undefined))).status).toBe(200);

        const started = yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined));
        expect(started.status).toBe(200);
        const viewer = yield* connect(r.server.port, "/ws", undefined);

        yield* Effect.tryPromise(() => vi.waitFor(() => expect(names(viewer.frames).at(-1)).toEqual([])));
        const { dir } = (yield* Effect.tryPromise(() => started.json())) as { dir: string };
        expect((yield* logLines(dir)).filter((l) => l.type === "speaker-name")).toEqual([]);
      }));
  });

  // 閲覧の共有（ADR 0003）。常駐サーバーと同じセッションの上で 開く → 状態 → 閉じる → 開き直す を続けて観測する。
  // 閲覧の口は本物の待受け（空きポート）。LAN のアドレスは実機のものなので、URL は形だけを見る
  describe("閲覧の共有（ADR 0003）", () => {
    const START = '{"app":"us.zoom.xos","title":"週次"}';
    const share = (r: { request: (method: string, path: string, body: string | undefined, origin: string | undefined) => Promise<Response> }, method: string, path: string) =>
      Effect.tryPromise(async () => {
        const response = await r.request(method, path, undefined, undefined);
        return { status: response.status, body: (await response.json()) as { status: string; urls?: string[]; pin?: string; error?: string } };
      });
    const viewingPortOf = (url: string) => Number(new URL(url).port);

    it.live("セッションが無ければ開けない（409）。開くと URL（PIN 付き）が返り、閲覧の口が待ち受ける。状態も同じ値。開き直しても同じ URL", () => Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([{}]);
      expect((yield* share(r, "POST", "/share/open")).status).toBe(409);
      expect((yield* share(r, "GET", "/share/status")).body).toEqual({ status: "off" });
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined))).status).toBe(200);
      const opened = yield* share(r, "POST", "/share/open");
      expect(opened.status).toBe(200);
      expect(opened.body.status).toBe("open");
      expect(opened.body.pin).toMatch(/^\d{6}$/);
      for (const url of opened.body.urls!) expect(url).toMatch(new RegExp(`^http://[0-9.]+:\\d+/\\?pin=${opened.body.pin}$`));
      expect((yield* share(r, "GET", "/share/status")).body).toEqual(opened.body);
      expect((yield* share(r, "POST", "/share/open")).body).toEqual(opened.body);
      // 閲覧の口は 127.0.0.1 からも PIN 付きで開ける（URL が無い機械でも、状態の PIN で確かめる）
      if (opened.body.urls!.length > 0) {
        const port = viewingPortOf(opened.body.urls![0]!);
        expect(port).not.toBe(r.server.port);
        expect((yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${port}/?pin=${opened.body.pin}`))).status).toBe(200);
        expect((yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${port}/`))).status).toBe(403);
      }
    }));

    it.live("閉じると状態は無しに戻り、閲覧の口は閉じる。閉じた後は新しい PIN で開き直せる。セッションの終了でも閉じる", () => Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([{}, {}]);
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined))).status).toBe(200);
      const first = yield* share(r, "POST", "/share/open");
      const closed = yield* share(r, "POST", "/share/close");
      expect(closed.status).toBe(200);
      expect(closed.body).toEqual({ status: "off" });
      if (first.body.urls!.length > 0) {
        const port = viewingPortOf(first.body.urls![0]!);
        yield* Effect.tryPromise(() => expect(fetch(`http://127.0.0.1:${port}/?pin=${first.body.pin}`)).rejects.toThrow());
      }
      // 閉じていなくても閉じるは成功する
      expect((yield* share(r, "POST", "/share/close")).body).toEqual({ status: "off" });
      const second = yield* share(r, "POST", "/share/open");
      expect(second.status).toBe(200);
      expect((yield* share(r, "GET", "/share/status")).body.status).toBe("open");
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/stop", undefined, undefined))).status).toBe(200);
      expect((yield* share(r, "GET", "/share/status")).body).toEqual({ status: "off" });
      if (second.body.urls!.length > 0) {
        const port = viewingPortOf(second.body.urls![0]!);
        yield* Effect.tryPromise(() => expect(fetch(`http://127.0.0.1:${port}/?pin=${second.body.pin}`)).rejects.toThrow());
      }
    }));

    it.live("cli share が URL と PIN を標準出力に出し、cli status に共有中の行が足され、cli share --stop で閉じる", () => Effect.gen(function* () {
      const r = yield* resourceWithFakeHelpers([{}]);
      const cli = (args: string[]) => Effect.suspend(() => {
        const out: string[] = [];
        const consoleService: Console.Console = { ...console, log: (...a: unknown[]) => { out.push(a.map(String).join(" ") + "\n"); } };
        const cliLayer = Layer.mergeAll(
          NodeServices.layer,
          NodeHttpClient.layerUndici,
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LIVE_MINDMAP_SESSIONS: r.sessionsDir, LIVE_MINDMAP_PORT: String(r.server.port) })),
          Layer.succeed(Console.Console, consoleService),
          Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed("") })),
        );
        return runCli(args).pipe(Effect.provide(cliLayer), Effect.map(() => out.join("")));
      });
      expect((yield* Effect.tryPromise(() => r.request("POST", "/session/start", START, undefined))).status).toBe(200);
      const opened = yield* cli(["share"]);
      const status = (yield* share(r, "GET", "/share/status")).body;
      expect(opened).toContain("閲覧の共有を開きました");
      expect(opened).toContain(`PIN: ${status.pin}`);
      for (const url of status.urls!) expect(opened).toContain(url);
      expect(yield* cli(["status"])).toContain("閲覧の共有: 共有中");
      expect(yield* cli(["share", "--stop"])).toBe("閲覧の共有を閉じました\n");
      expect(yield* cli(["status"])).toContain("閲覧の共有: 無し");
    }));
  });
});
