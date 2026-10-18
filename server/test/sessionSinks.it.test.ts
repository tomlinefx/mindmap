import { defaultClaude } from "../src/modelSelection.ts";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Console, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { TestClock } from "effect/testing";
import { DiffUpdatePaused, DiffUpdater, REVIEW_LOG_ELEMENT_ID, SETTLE_QUIET_MS, type DiffInput, type Snapshot, type CaptionsFrame } from "../src/core/index.ts";
import { ReviewBuild } from "../src/review.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { SPEAKING_INTERVAL_MS } from "../src/speakingRelay.ts";
import { collectingConsole, failingBuild, FAKE_TEMPLATE, fakeExportServices, type ExportServicesOptions } from "./fixtures/exportServices.ts";
import { trackedFileSystem } from "./fixtures/trackedFileSystem.ts";

// Issue #240 段 3（ADR 0008）→ Issue #243 段 6: SessionSinks の実物 Layer を、実 tmpdir + 偽の DiffUpdater／capture で確かめる。
// updater・ログ・いま話している文字・書き出しを開く契約（CT-SINK-SCOPE）と、録音ファイル名の採番（要件117,127）
// がこのファイルの対象。段 6 で、SessionSinks は新しいセッション（makeSession）を直接使う。
// 1 秒の途中結果（SETTLE_QUIET_MS）の待ちは、音声の時刻（後続の結果の end）で進める（壁時計では進まない。本物の時間では待たない）。
//
// 想定する契約（server/src/sessionSinks.ts）:
// - `SessionSinks.layer({ prepareUpdater: () => Effect.succeed(updaterLayer) })` が実物の Layer を作る。見返し用の HTML のビルド・FileSystem は Layer の文脈から受け取る（テストの sinksLayer が偽物を渡す）。
//   updaterLayer は core の Service DiffUpdater を作る Layer で、セッションごとに Layer.build(Layer.fresh(...)) して使う
// - `createDir(sessionsDir)` がセッションのフォルダを作る（失敗すれば以後 open を呼ばない。要件3の前提）
// - `open({ dir, title, publish, speak })` がセッションの Scope の中で 1 回呼ばれ、updater をそのセッションの Scope で開き、
//   `SessionSink`（partial・final・drain・clearSpeaking・stopRelays・appendLog・flush・exports・audioFileNames）を返す。
//   Scope を閉じると updater が閉じる

// 開いた数・閉じた数・呼ばれた数を数える偽の DiffUpdater の Layer。開くたびに別の実体（id）を作る
function makeFakeUpdater() {
  const state = { opened: 0, closed: 0, calls: 0, callIds: [] as number[] };
  const updaterLayer = Layer.effect(
    DiffUpdater,
    Effect.gen(function* () {
      const id = yield* Effect.acquireRelease(
        Effect.sync(() => ++state.opened),
        () =>
          Effect.sync(() => {
            state.closed++;
          }),
      );
      return DiffUpdater.of({
        update: () =>
          Effect.sync(() => {
            state.calls++;
            state.callIds.push(id);
            return { ops: [] };
          }),
      });
    }),
  );
  return { updaterLayer, state };
}

// 終了時の書き出しが文脈から受け取る Service（見返し用の HTML のビルド）は偽物の Layer で渡す。
// HTML は書き出し（ログの読み込み・埋め込み・書き込み）が本物でビルドだけ偽物
// ログ・export.json は実物の FileSystem で書くので、書き込みの完了は Effect のスケジューラの外にある。
// 時間を進める前後の待ち（settle・settleUntil）は、実行中のファイル操作が終わるまで実時間で待つ（trackedFileSystem）
const fileIo = trackedFileSystem();
const { settle, settleUntil } = fileIo;
const sinksLayer = ({ updaterLayer, ...services }: { updaterLayer: Layer.Layer<DiffUpdater> } & ExportServicesOptions) =>
  SessionSinks.layer({ prepareUpdater: () => Effect.succeed(updaterLayer) }).pipe(Layer.provide(fakeExportServices({ fileSystem: fileIo.layer, ...services })));

// Issue #1021: 相手の発言は話者の確定区間が揃うまで（最大 3 秒）出ない。話者に関係しない観測のテストは、始めに speaker-off を渡して、相手の発言を待たずに話者なしで出す。
// 話者の決定と待ちは、末尾の describe（speakerOff: false で開く）が対象にする
const SPEAKER_OFF = { type: "speaker-off", start: 0, reason: "モデルなし" } as const;

const withTmpSessionsDir = Effect.fn("withTmpSessionsDir")(function* () {
  return yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-sinks-"))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );
});

describe("SessionSinks（実物 Layer）", () => {
  it.effect("準備で取得する推論子はサービス構築時ではなく準備を呼ぶ Scope で閉じる", () => Effect.gen(function* () {
    const state = { opened: 0, closed: 0 };
    const sinks = yield* SessionSinks.pipe(Effect.provide(SessionSinks.layer({
      prepareUpdater: () => Effect.acquireRelease(
        Effect.sync(() => {
          state.opened++;
          return Layer.succeed(DiffUpdater, DiffUpdater.of({ update: () => Effect.succeed({ ops: [] }) }));
        }),
        () => Effect.sync(() => { state.closed++; }),
      ),
    }).pipe(Layer.provide(fakeExportServices()))));
    for (let attempt = 1; attempt <= 2; attempt++) {
      const scope = yield* Effect.acquireRelease(Scope.make(), (made) => Scope.close(made, Exit.void));
      yield* Scope.provide(sinks.prepare(defaultClaude), scope);
      expect(state).toMatchObject({ opened: attempt, closed: attempt - 1 });
      yield* Scope.close(scope, Exit.void);
      expect(state).toMatchObject({ opened: attempt, closed: attempt });
    }
  }));

  it.effect("updater はセッションの Scope の資源で、Scope を閉じると閉じる（CT-SINK-SCOPE）", () => {
    const { updaterLayer, state } = makeFakeUpdater();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      expect(state.opened).toBe(0); // フォルダを作っただけでは開かない

      const scope = yield* Scope.make();
      yield* Scope.provide(
        sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void }),
        scope,
      );
      expect(state).toMatchObject({ opened: 1, closed: 0 });

      yield* Scope.close(scope, Exit.void);
      expect(state).toMatchObject({ opened: 1, closed: 1 });
    }).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  // TestClock の時刻は 1970 年。Clock に従う書き方に替えると、フォルダ名と at が 1970 年になって落ちる
  it.effect("フォルダ名の時刻と log.jsonl の at は、TestClock の下でも実時刻（Clock に従わない）", () => {
    const { updaterLayer } = makeFakeUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const before = Date.now();
      const dir = yield* sinks.createDir(sessionsDir);
      const folderTime = Date.parse(basename(dir).replace(/T(\d\d)-(\d\d)-(\d\d)/, "T$1:$2:$3"));
      expect(folderTime).toBeGreaterThanOrEqual(before);
      expect(folderTime).toBeLessThanOrEqual(Date.now());

      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
      const beforeLog = Date.now();
      yield* sink.appendLog({ type: "intake-restarted", trigger: "auto" });
      yield* sink.flush;
      yield* settleUntil(() => existsSync(join(dir, "log.jsonl")) && readFileSync(join(dir, "log.jsonl"), "utf8").includes("intake-restarted"));
      const entry = readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)).find((e) => e.type === "intake-restarted");
      const at = Date.parse(entry.at);
      expect(at).toBeGreaterThanOrEqual(beforeLog);
      expect(at).toBeLessThanOrEqual(Date.now());
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("フォルダを作れないと createDir が失敗し、open を呼ばなければ updater も開かない", () => {
    const { updaterLayer, state } = makeFakeUpdater();
    return Effect.gen(function* () {
      const tmp = yield* withTmpSessionsDir();
      const blocker = join(tmp, "blocker");
      writeFileSync(blocker, ""); // 親のフォルダの位置に通常ファイルを置き、mkdir できなくする
      const sinks = yield* SessionSinks;

      const result = yield* Effect.exit(sinks.createDir(join(blocker, "sessions")));

      expect(result._tag).toBe("Failure");
      expect(state).toMatchObject({ opened: 0, closed: 0 });
    }).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("発言の ID はセッションにつき 1 つのクロージャで、r1 から順に増える（要件125）", () =>
    Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);

      yield* sink.final({ track: "相手", start: 0, end: 1, text: "ひとつめ" });
      yield* sink.final({ track: "自分", start: 2, end: 3, text: "ふたつめ" });
      yield* sink.flush;

      const log = yield* Effect.sync(() => readFileSync(join(dir, "log.jsonl"), "utf8"));
      const remarkIds = log.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)).filter((e) => e.type === "remark").map((e) => e.remark.id);
      expect(remarkIds).toEqual(["r1", "r2"]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer }))));

  it.effect("sink.speaker の speaker・speaker-off は生の値のまま log.jsonl に受け取った順で書かれ、差分更新の入力に載らない", () => {
    const inputs: DiffInput[] = [];
    const updaterLayer = Layer.succeed(
      DiffUpdater,
      DiffUpdater.of({ update: (input) => Effect.sync(() => { inputs.push(input); return { ops: [] }; }) }),
    );
    return Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });

      yield* sink.speaker({ type: "speaker", track: "相手", start: 1.5, end: 2.5, slot: 1, final: false });
      yield* sink.final({ track: "相手", start: 3, end: 4, text: "採用" });
      yield* sink.speaker({ type: "speaker", track: "相手", start: 0, end: 1.5, slot: 0, final: true });
      yield* sink.speaker({ type: "speaker-off", start: 9, reason: "読み込みに失敗" });
      yield* sink.flush;

      const log = readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
      const speakerLines = log.filter((e) => e.type === "speaker" || e.type === "speaker-off");
      expect(speakerLines.map(({ at, ...rest }) => ({ hasAt: typeof at === "string", rest }))).toEqual([
        { hasAt: true, rest: { type: "speaker", track: "相手", start: 1.5, end: 2.5, slot: 1, final: false } },
        { hasAt: true, rest: { type: "speaker", track: "相手", start: 0, end: 1.5, slot: 0, final: true } },
        { hasAt: true, rest: { type: "speaker-off", start: 9, reason: "読み込みに失敗" } },
      ]);
      expect(log.map((e) => e.type).filter((t) => t === "start" || t === "speaker" || t === "speaker-off" || t === "remark")).toEqual(["start", "speaker", "speaker", "speaker-off", "remark"]);
      for (const input of inputs) expect(JSON.stringify(input)).not.toContain("speaker");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("exports は書き出した 4 パスを返す（4 つ目が map.html）", () =>
    Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });
      yield* sink.flush;

      const paths = yield* sink.exports;

      expect(paths.map((p) => basename(p))).toEqual(["map.md", "map.json", "map.drawnix", "map.html"]);
      for (const path of paths) expect(existsSync(path)).toBe(true);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer }))));

  it.effect("map.html の書き出しが失敗しても exports はほかの 3 パスを返し、標準エラーに理由を残す", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });
      yield* sink.flush;

      const paths = yield* sink.exports.pipe(Effect.provideService(Console.Console, warnings.service));

      expect(paths.map((p) => basename(p))).toEqual(["map.md", "map.json", "map.drawnix"]);
      expect(existsSync(join(dir, "map.html"))).toBe(false);
      expect(warnings.errors.some((s) => s.includes("map.html を書き出せませんでした: ビルドに失敗"))).toBe(true);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, build: failingBuild() }))));

  const openWithRemark = Effect.gen(function* () {
    const sessionsDir = yield* withTmpSessionsDir();
    const sinks = yield* SessionSinks;
    const dir = yield* sinks.createDir(sessionsDir);
    const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
    yield* sink.speaker(SPEAKER_OFF);
    yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });
    yield* sink.flush;
    return { dir, sink };
  });
  const fileNames = (paths: readonly string[]) => paths.map((p) => basename(p));

  it.effect("map.html のビルドが defect で失敗しても、exports はほかの 3 パスを返し、標準エラーに理由を残す", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const { dir, sink } = yield* openWithRemark;

      const paths = yield* sink.exports.pipe(Effect.provideService(Console.Console, warnings.service));

      expect(fileNames(paths)).toEqual(["map.md", "map.json", "map.drawnix"]);
      expect(existsSync(join(dir, "map.html"))).toBe(false);
      expect(warnings.errors).toEqual(["map.html を書き出せませんでした: ビルドが落ちた"]);
    })).pipe(
      Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, build: Effect.die(new Error("ビルドが落ちた")) })),
    ));

  it.effect("サーバーの警告は、map.html の失敗の理由の改行を残す", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const { sink } = yield* openWithRemark;

      yield* sink.exports.pipe(Effect.provideService(Console.Console, warnings.service));

      expect(warnings.errors).toContain("map.html を書き出せませんでした: ビルドに失敗\n詳細");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer, build: failingBuild("ビルドに失敗\n詳細") }))));

  it.effect("テキストの 3 形式を書けないときは、失敗の値ではなく defect になる（撮影・HTML の失敗のように諦めない）", () =>
    Effect.scoped(Effect.gen(function* () {
      const warnings = collectingConsole();
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
      rmSync(dir, { recursive: true, force: true }); // 書き先のフォルダが無くなる

      const exit = yield* sink.exports.pipe(Effect.provideService(Console.Console, warnings.service), Effect.exit);

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause) && !Cause.hasFails(exit.cause)).toBe(true);
      expect(warnings.errors).toEqual([]); // 諦めた警告ではない
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer }))));

  it.effect("exports で書く map.html には、そのセッションの log.jsonl の出来事がそのまま埋め込まれる", () =>
    Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void });
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final({ track: "相手", start: 0, end: 1, text: "採用" });
      yield* sink.flush;

      yield* sink.exports;

      const log = readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
      const html = readFileSync(join(dir, "map.html"), "utf8");
      const match = new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
      expect(match).not.toBeNull();
      expect(JSON.parse(match![1]!)).toEqual(log);
      expect(log.length).toBeGreaterThan(0);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeFakeUpdater().updaterLayer }))));

  // Layer はメモ化されるので、サーバーで 1 回だけ作ると 2 つのセッションが 1 つの updater（query）を使い回してしまう。
  // セッションごとに Layer.build(Layer.fresh(updaterLayer)) するので、同じ SessionSinks の上で続けて開いたセッションは別の updater を持つ
  it.live("同じ SessionSinks で 2 つのセッションを続けて開閉すると、updater は別の実体で、開いた回数・閉じた回数がどちらも 2 になる（CT-PER-SESSION-UPDATER）", () => {
    const { updaterLayer, state } = makeFakeUpdater();
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const noop = { publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void };

      const firstScope = yield* Scope.make();
      const first = yield* Scope.provide(sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir: yield* sinks.createDir(sessionsDir), title: "一つ目", ...noop }), firstScope);
      yield* first.speaker(SPEAKER_OFF);
      expect(state).toMatchObject({ opened: 1, closed: 0 });
      yield* first.final({ track: "相手", start: 0, end: 1, text: "ひとつめの発言" });
      yield* first.flush; // 1 つ目の updater で差分更新が呼ばれる
      yield* Scope.close(firstScope, Exit.void);
      expect(state).toMatchObject({ opened: 1, closed: 1 });

      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5))); // フォルダ名は開始時刻（実時間のミリ秒）
      const secondScope = yield* Scope.make();
      const second = yield* Scope.provide(sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir: yield* sinks.createDir(sessionsDir), title: "二つ目", ...noop }), secondScope);
      yield* second.speaker(SPEAKER_OFF);
      expect(state).toMatchObject({ opened: 2, closed: 1 }); // 2 つ目は 1 つ目を使い回さず、新しく開く
      yield* second.final({ track: "相手", start: 0, end: 1, text: "ふたつめの発言" });
      yield* second.flush;
      yield* Scope.close(secondScope, Exit.void);

      expect(state).toMatchObject({ opened: 2, closed: 2 });
      expect(state.callIds).toEqual([1, 2]); // それぞれのセッションの差分更新は、そのセッションの updater（別の実体）が受けた
    }).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

});

// 送った字幕のフレームの読み取り
const hasBubble = (speaks: readonly CaptionsFrame[], track: "相手" | "自分", text: string) => speaks.some((f) => f.bubbles.some((b) => b.track === track && b.text.includes(text)));
const lastTexts = (speaks: readonly CaptionsFrame[], track: "相手" | "自分") => speaks.at(-1)?.bubbles.filter((b) => b.track === track).map((b) => b.text);

// 公開したスナップショット・送った captions を記録する Sink の組み立て
const openRecordingSink = Effect.fn("openRecordingSink")(function* ({ speakerOff = true }: { speakerOff?: boolean } = {}) {
  const sessionsDir = yield* withTmpSessionsDir();
  const sinks = yield* SessionSinks;
  const dir = yield* sinks.createDir(sessionsDir);
  const speaks: CaptionsFrame[] = [];
  const published: Snapshot[] = [];
  const sink = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude,
    dir,
    title: "週次",
    publish: (snapshot) => Effect.sync(() => void published.push(snapshot)),
    speak: (frame) => Effect.sync(() => void speaks.push(frame)),
    speakerNames: () => Effect.void,
  });
  if (speakerOff) yield* sink.speaker(SPEAKER_OFF);
  return { sink, dir, speaks, published };
});

// 差分更新に渡った入力を記録する偽の DiffUpdater の Layer。
// updateGate.gate を設定すると、差分更新はその Deferred が完了するまで返らない（呼び出し中のまま止めて、反映前の状態を見る）
const makeRecordingUpdater = () => {
  const calls: DiffInput[] = [];
  const updateGate: { gate: Deferred.Deferred<void> | null } = { gate: null };
  const updaterLayer = Layer.succeed(
    DiffUpdater,
    DiffUpdater.of({
      update: (input) =>
        Effect.gen(function* () {
          calls.push(input);
          if (updateGate.gate !== null) yield* Deferred.await(updateGate.gate);
          return { ops: [] };
        }),
    }),
  );
  return { calls, updateGate, updaterLayer };
};

const logEvents = (dir: string) =>
  readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));

const finalRemark = (track: "相手" | "自分", start: number, end: number, text: string) => ({ track, start, end, text });

describe("SessionSinks（実物 Layer）: 発言の確定・途中結果・書き出し", () => {
  it.effect("確定結果が来なくても、相手の途中結果は 1 秒更新されなければ、最後の本文・区間で発言が 1 件、差分更新に渡る。ID は r1 で、ログにも残る", () => {
    const { calls, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 5, end: 7.5, text: "あしたの", duplicate: false });
      yield* sink.partial({ track: "相手", start: 5, end: 8, text: "あしたの会議は", duplicate: false });

      yield* sink.partial({ track: "自分", start: 0, end: 8 + (SETTLE_QUIET_MS - 1) / 1000, text: "時計を進める", duplicate: false }); // 自分の途中結果は発言にならず、音声の時計だけを進める
      yield* settle;
      expect(logEvents(dir).filter((e) => e.type === "remark")).toEqual([]); // 1 秒の直前まではまだ発言にならない
      yield* sink.partial({ track: "自分", start: 0, end: 8 + SETTLE_QUIET_MS / 1000, text: "時計を進める", duplicate: false }); // 自分の途中結果は発言にならず、音声の時計だけを進める // 音声の時刻で 1 秒更新されなかった: 発言になり、すぐ差分更新に渡る
      yield* settle;
      expect(logEvents(dir).filter((e) => e.type === "remark")).toHaveLength(1);
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);
      expect(calls.flatMap((c) => c.fresh)[0]).toMatchObject({ id: "r1", track: "相手", start: 5, end: 8, text: "あしたの会議は" });

      yield* sink.drain;
      yield* sink.flush;
      expect(calls.flatMap((c) => c.fresh)).toHaveLength(1); // 終了処理で増えない
      expect(logEvents(dir).filter((e) => e.type === "remark").map((e) => [e.remark.id, e.remark.text])).toEqual([["r1", "あしたの会議は"]]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("出した後に届いた確定結果は捨てる。発言は増えず、次の発言の ID は r2 で番号が飛ばない", () => {
    const { calls, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 5, end: 8, text: "あしたの会議", duplicate: false });
      yield* sink.partial({ track: "自分", start: 0, end: 8 + SETTLE_QUIET_MS / 1000, text: "時計を進める", duplicate: false }); // 自分の途中結果は発言にならず、音声の時計だけを進める
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);

      yield* sink.final(finalRemark("相手", 5.2, 8.2, "明日の会議は十時です。")); // r1 を覆う確定結果。本文が違っても捨てる
      yield* sink.final(finalRemark("相手", 30, 32, "べつの確定結果"));
      yield* sink.drain;
      yield* sink.flush;

      const fresh = calls.flatMap((c) => c.fresh);
      expect(fresh.map((u) => u.id)).toEqual(["r1", "r2"]);
      expect(fresh.some((u) => u.text.includes("十時です"))).toBe(false);
      expect(logEvents(dir).filter((e) => e.type === "remark").map((e) => [e.remark.id, e.remark.text])).toEqual([["r1", "あしたの会議"], ["r2", "べつの確定結果"]]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("drain は、まだ出ていない発話を落とさない。途中結果の最後の本文が差分更新に渡る", () => {
    const { calls, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 5, end: 8, text: "とちゅうでとめた", duplicate: false });

      yield* sink.drain; // 時間は進めない（1 秒を待たずに発言にする）
      yield* sink.flush;

      expect(calls.flatMap((c) => c.fresh).map((u) => [u.id, u.text])).toEqual([["r1", "とちゅうでとめた"]]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("自分の途中結果は、1 秒を超えても発言にならない（相手の同じ入力は発言になる）。自分の発言は確定結果だけから作られる", () => {
    const { calls, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 5, end: 6, text: "あいてのとちゅう", duplicate: false });
      yield* sink.partial({ track: "自分", start: 5, end: 6, text: "じぶんのとちゅう", duplicate: false });
      yield* sink.final(finalRemark("自分", 20, 22, "じぶんの確定結果"));

      // 守っている状態に到達する: 相手の途中結果は 1 秒経って出ている（自分の途中結果は同時に届いており、出るなら同じ時刻に出る）
      yield* TestClock.adjust(SETTLE_QUIET_MS);
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).some((u) => u.text === "あいてのとちゅう"));
      yield* sink.drain;
      yield* sink.flush;

      const fresh = calls.flatMap((c) => c.fresh);
      expect(fresh.map((u) => [u.track, u.text])).toEqual(expect.arrayContaining([["相手", "あいてのとちゅう"], ["自分", "じぶんの確定結果"]]));
      expect(fresh).toHaveLength(2);
      expect(fresh.some((u) => u.text === "じぶんのとちゅう")).toBe(false);
      expect(logEvents(dir).filter((e) => e.type === "remark")).toHaveLength(2);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("発言が 1 件だけ届いたとき、時間を進めなくても flush を待たずにその 1 件で差分更新がすぐ呼ばれ、反映後のマップが公開される。時間を進めても呼び出しは増えない", () => {
    const { calls, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, published } = yield* openRecordingSink();
      yield* sink.final(finalRemark("相手", 1, 5, "採用の面接について"));

      yield* settleUntil(() => calls.length > 0); // 時間は進めていない
      expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1"]]);
      yield* settleUntil(() => published.length >= 2);
      expect(published.map((s) => s.round)).toEqual([0, 1]);
      yield* TestClock.adjust(600_000); // 時間では呼ばない
      yield* settle;
      expect(calls).toHaveLength(1);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("途中結果は captions として届く。重複の印の付いた自分の途中結果は出ず、印のないものは出る。stopRelays で空の並びになり、以後は送らない", () =>
    Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 1, end: 3, text: "はじまりの途中結果", duplicate: false });
      yield* sink.partial({ track: "自分", start: 1, end: 2, text: "もれたあいてのこえ", duplicate: true });
      yield* sink.partial({ track: "自分", start: 3, end: 4, text: "じぶんのこえ", duplicate: false });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => hasBubble(speaks, "自分", "じぶんのこえ"));
      expect(hasBubble(speaks, "自分", "じぶんのこえ")).toBe(true);
      expect(speaks[0]).toMatchObject({ type: "captions", bubbles: [{ track: "相手", text: "はじまりの途中結果" }] });
      expect(hasBubble(speaks, "自分", "もれたあいてのこえ")).toBe(false);

      yield* sink.stopRelays;
      expect(speaks.at(-1)).toEqual({ type: "captions", bubbles: [] });
      const sent = speaks.length;
      yield* sink.partial({ track: "相手", start: 9, end: 10, text: "終了後の途中結果", duplicate: false });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS + 100);
      yield* settle;
      expect(speaks).toHaveLength(sent);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer }))));

  it.effect("文字を送った後、途中結果が増えなくても、話者の区間の更新（speaker / speaker-settled）だけで字幕のラベルが替わる。id と文字は保たれる", () =>
    Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink({ speakerOff: false });
      yield* sink.partial({ track: "相手", start: 10, end: 12, text: "こんにちは", duplicate: false });
      yield* sink.speaker({ type: "speaker", track: "相手", start: 10, end: 12, slot: 0, final: false });
      yield* sink.speaker({ type: "speaker-settled", track: "相手", to: 12 });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => speaks.at(-1)?.bubbles[0]?.label === "仮");
      const first = speaks.at(-1)!.bubbles[0]!;
      expect(first).toMatchObject({ label: "仮", text: "こんにちは" });

      yield* sink.speaker({ type: "speaker", track: "相手", start: 10, end: 12, slot: 1, final: false });
      yield* sink.speaker({ type: "speaker-settled", track: "相手", to: 12 });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => speaks.at(-1)?.bubbles[0]?.speaker !== first.speaker);

      const next = speaks.at(-1)!;
      expect(next.bubbles).toHaveLength(1);
      expect(next.bubbles[0]).toMatchObject({ id: first.id, text: "こんにちは", label: "仮" });
      expect(next.bubbles[0]!.speaker).not.toBe(first.speaker);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer }))));

  it.effect("clearSpeaking は字幕を空の並びにするが、以後も途中結果を送れる", () =>
    Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 1, end: 3, text: "ひとつめ", duplicate: false });
      yield* settleUntil(() => hasBubble(speaks, "相手", "ひとつめ"));
      expect(hasBubble(speaks, "相手", "ひとつめ")).toBe(true);

      yield* sink.clearSpeaking;
      expect(speaks.at(-1)).toEqual({ type: "captions", bubbles: [] });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* sink.partial({ track: "相手", start: 4, end: 5, text: "ふたつめ", duplicate: false });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => hasBubble(speaks, "相手", "ふたつめ"));
      expect(hasBubble(speaks, "相手", "ふたつめ")).toBe(true);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer }))));

  it.effect("発言が 1 件も来ないセッションでも、exports はそのセッションのマップ（空の会議ノード）を書き出す", () =>
    Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();

      const paths = yield* sink.exports;

      expect(paths).toHaveLength(4);
      expect(JSON.parse(readFileSync(join(dir, "map.json"), "utf8")).root).toMatchObject({ kind: "会議", text: "週次", children: [] });
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer }))));

  it.effect("flush は最後の差分更新（r3 を含む）が終わるまで待ち、その後に Scope を閉じて updater を閉じる。閉じた後には呼ばれない（base:581）", () => {
    const state = { calls: [] as string[][], closed: 0, callsAfterClose: 0 };
    const updaterLayer = Layer.effect(
      DiffUpdater,
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            state.closed++;
          }),
        );
        return DiffUpdater.of({
          update: (input) =>
            Effect.gen(function* () {
              yield* Effect.sleep(30); // 反映に時間がかかる（TestClock で進める）
              if (state.closed > 0) state.callsAfterClose++;
              state.calls.push(input.fresh.map((u) => u.id));
              return { ops: [] };
            }),
        });
      }),
    );
    return Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const dir = yield* sinks.createDir(sessionsDir);
      const scope = yield* Scope.make();
      const sink = yield* Scope.provide(sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir, title: "週次", publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void }), scope);
      yield* sink.speaker(SPEAKER_OFF);
      yield* sink.final(finalRemark("相手", 1, 2, "ひとつめ"));
      yield* sink.final(finalRemark("自分", 3, 4, "ふたつめ"));
      yield* sink.final(finalRemark("相手", 5, 6, "みっつめ"));

      const flushing = yield* Effect.forkChild(sink.flush);
      for (let i = 0; i < 3; i++) {
        yield* TestClock.adjust(30); // r1 の反映、続けて（r1 の呼び出し中に届いた）r2+r3 のまとめの反映が、それぞれ 30 ms かかる
        yield* settle;
      }
      yield* Fiber.join(flushing);
      expect(state.calls).toEqual([["r1"], ["r2", "r3"]]); // flush が戻った時点で、3 件とも差分更新に渡っている。r1 はすぐ、r2・r3 は r1 の呼び出し中に届いたので 1 回にまとまる
      expect(state.closed).toBe(0);
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust(100);
      yield* settle;

      expect(state).toMatchObject({ closed: 1, callsAfterClose: 0 });
    }).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("反映前の確定した発言は、自分の captions にも出る（emit が relay.remark へつながる。base:301）", () => {
    const { calls, updateGate, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink();
      updateGate.gate = yield* Deferred.make<void>(); // 差分更新は呼ばれても返らない（反映前のまま）

      yield* sink.final(finalRemark("自分", 1, 2, "面接は何回にしますか"));
      yield* settleUntil(() => calls.length === 1);

      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => hasBubble(speaks, "自分", "面接は何回にしますか"));
      expect(hasBubble(speaks, "自分", "面接は何回にしますか")).toBe(true);
      yield* Deferred.succeed(updateGate.gate, undefined);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  // Issue #1222: 発言にした後に、STT が同じ区切りを延ばした途中結果が届く。字幕へは、もう発言になった分を除いた後ろだけを渡す
  it.effect("発言 → 同じ区切りが延びた途中結果の順に届いても、送ったどのフレームにも同じ文字が 2 回現れない。後ろだけが途中結果の吹き出しに出る", () => {
    const { calls, updateGate, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink();
      updateGate.gate = yield* Deferred.make<void>(); // 差分更新は呼ばれても返らない（発言は反映前のまま字幕に残る）
      const wordTimes = [{ location: 0, length: 3, start: 0, end: 0.5 }, { location: 3, length: 5, start: 0.5, end: 1.2 }];
      yield* sink.partial({ track: "相手", start: 0, end: 1.2, text: "来週のリリースは", wordTimes, duplicate: false });
      yield* sink.partial({ track: "自分", start: 0, end: 1.2 + SETTLE_QUIET_MS / 1000, text: "時計を進める", duplicate: false }); // 自分の途中結果で音声の時計だけを進め、相手の途中結果を発言にする
      yield* settleUntil(() => calls.length === 1);

      yield* sink.partial({ track: "相手", start: 0, end: 2, text: "来週のリリースは金曜に", wordTimes: [...wordTimes, { location: 8, length: 3, start: 1.3, end: 2 }], duplicate: false });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => hasBubble(speaks, "相手", "金曜に"));

      expect(lastTexts(speaks, "相手")).toEqual(["来週のリリースは", "金曜に"]);
      for (const frame of speaks) expect(frame.bubbles.map((b) => b.text).join("").split("来週").length - 1).toBeLessThanOrEqual(1);
      yield* Deferred.succeed(updateGate.gate, undefined);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("差分更新で反映された発言は、相手の最後の captions から消える（onDiff が relay.flushAll につながる）。反映前は本文が出ている", () => {
    const { calls, updateGate, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink();
      const reply = yield* Deferred.make<void>();
      updateGate.gate = reply; // 差分更新は呼ばれても返らない（反映前のまま）

      yield* sink.partial({ track: "自分", start: 5, end: 6, text: "じぶんのとちゅう", duplicate: false });
      yield* sink.final(finalRemark("相手", 1, 5, "採用の面接について"));
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => lastTexts(speaks, "相手")?.[0] === "採用の面接について");
      expect(lastTexts(speaks, "相手")).toEqual(["採用の面接について"]); // 反映前: 確定した発言の本文が出ている
      expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1"]]); // 発言 1 件ですぐ呼ばれているが、まだ返っていない

      yield* Deferred.succeed(reply, undefined);
      yield* settleUntil(() => lastTexts(speaks, "相手")?.length === 0);
      expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1"]]);
      expect(lastTexts(speaks, "相手")).toEqual([]); // 反映後: 処理済みの発言が消えている
      expect(lastTexts(speaks, "自分")).toEqual(["じぶんのとちゅう"]); // 反映に渡していない途中結果は残る
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  // フォルダ名は開始時刻（実時間のミリ秒）なので、このテストだけ実時間の短い待ち（5 ms）を使う
  it.live("同じ sessionsDir の 2 つ目のセッションは、発言が 1 件も無くても、作成直後の export.json がそのセッションのマップ（前のセッションではない。base:510）", () =>
    Effect.scoped(Effect.gen(function* () {
      const sessionsDir = yield* withTmpSessionsDir();
      const sinks = yield* SessionSinks;
      const noop = { publish: () => Effect.void, speak: () => Effect.void, speakerNames: () => Effect.void };
      const firstDir = yield* sinks.createDir(sessionsDir);
      const first = yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir: firstDir, title: "前", ...noop });
      yield* first.speaker(SPEAKER_OFF);
      yield* first.final(finalRemark("相手", 1, 2, "前の発言"));
      yield* first.flush;
      yield* first.exports;
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
      const secondDir = yield* sinks.createDir(sessionsDir);
      yield* sinks.open({ diffUpdate: () => Effect.void, updaterLayer: yield* sinks.prepare(defaultClaude), model: defaultClaude, dir: secondDir, title: "今", ...noop });

      expect(secondDir).not.toBe(firstDir);
      const exported = JSON.parse(readFileSync(join(secondDir, "export.json"), "utf8"));
      expect(JSON.stringify(exported)).toContain("今");
      expect(JSON.stringify(exported)).not.toContain("前の発言");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer: makeRecordingUpdater().updaterLayer }))));
});

// Issue #639: 発言の語ごとの読み（words）を log.jsonl の remark の行に残す。
// 補正はしないので、直す前の本文（raw）は関所を通った後の本文（remark.text）と同じ。
// words は Remark に入れず、差分更新への入力・スナップショット・書き出しには載らない。words の無いイベントの行は今までと同じ
describe("SessionSinks（実物 Layer）: 発言の語ごとの読み（Issue #639）", () => {
  const word = (surface: string, location: number) => ({ surface, romaji: `r:${surface}`, location, length: surface.length });
  const remarkLines = (dir: string) => logEvents(dir).filter((e) => e.type === "remark");

  it.effect("words 付きの確定結果は、log.jsonl の remark の行に直す前の本文（raw）と words が残る。remark 自体に words・raw は入らない", () => {
    const { updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      const words = [word("明日", 0), word("の", 2), word("会議", 3)];
      yield* sink.final({ track: "相手", start: 1, end: 3, text: "明日の会議", words });
      yield* sink.drain;
      yield* sink.flush;

      const lines = remarkLines(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0].raw).toBe("明日の会議");
      expect(lines[0].words).toEqual(words);
      expect(lines[0].remark).toEqual({ id: "r1", track: "相手", start: 1, end: 3, text: "明日の会議" });
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("途中結果から作った発言にも words が付き、行の raw は発言の本文と同じ", () => {
    const { updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 5, end: 7.5, text: "あした", duplicate: false, words: [word("あした", 0)] });
      yield* sink.partial({ track: "相手", start: 5, end: 8, text: "あしたの会議", duplicate: false, words: [word("あした", 0), word("の", 3), word("会議", 4)] });
      yield* sink.partial({ track: "自分", start: 0, end: 8 + SETTLE_QUIET_MS / 1000, text: "時計を進める", duplicate: false }); // 自分の途中結果は発言にならず、音声の時計だけを進める
      yield* settle;

      const lines = remarkLines(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0].remark.text).toBe("あしたの会議");
      expect(lines[0].raw).toBe("あしたの会議");
      expect(lines[0].words).toEqual([word("あした", 0), word("の", 3), word("会議", 4)]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("関所が頭を切った発言の行は、raw が切った後の本文と同じで、words は切った後の本文の位置に合う", () => {
    const { updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.final({ track: "相手", start: 10, end: 12, text: "あいう", words: [word("あいう", 0)] });
      yield* sink.final({ track: "相手", start: 11, end: 15, text: "あいうえお", words: [word("あい", 0), word("うえ", 2), word("お", 4)] });
      yield* sink.drain;
      yield* sink.flush;

      const lines = remarkLines(dir);
      expect(lines.map((e) => [e.remark.id, e.remark.text, e.raw])).toEqual([["r1", "あいう", "あいう"], ["r2", "えお", "えお"]]);
      // 切る位置は 3。"うえ" は途中で切れるので落ち、"お" は切った後の本文の位置 1 になる
      expect(lines[1].words).toEqual([word("お", 1)]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("自分の確定結果の行にも words が残る", () => {
    const { updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.final({ track: "自分", start: 0, end: 1, text: "はい", words: [word("はい", 0)] });
      yield* sink.drain;
      yield* sink.flush;

      expect(remarkLines(dir)[0]).toMatchObject({ raw: "はい", words: [word("はい", 0)] });
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("words の無いイベントから作った発言の行は今までと同じ（raw・words のキーが無い）", () => {
    const { updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.final({ track: "相手", start: 1, end: 2, text: "確定" });
      yield* sink.partial({ track: "相手", start: 5, end: 6, text: "途中", duplicate: false });
      yield* TestClock.adjust(SETTLE_QUIET_MS);
      yield* settle;
      yield* sink.drain;
      yield* sink.flush;

      const lines = remarkLines(dir);
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(Object.keys(line).sort()).toEqual(["at", "remark", "type"].filter((k) => k in line));
      for (const line of lines) {
        expect(line).not.toHaveProperty("raw");
        expect(line).not.toHaveProperty("words");
      }
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("words は差分更新への入力・書き出しに載らない（Remark の契約は変わらない）", () => {
    const { calls, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.final({ track: "相手", start: 1, end: 3, text: "明日の会議", words: [word("明日", 0), word("の", 2), word("会議", 3)] });
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);

      expect(calls.flatMap((c) => c.fresh)[0]).toEqual({ id: "r1", track: "相手", start: 1, end: 3, text: "明日の会議" });
      expect(JSON.stringify(calls)).not.toContain("words");
      yield* sink.drain;
      yield* sink.flush;
      yield* sink.exports;
      expect(readFileSync(join(dir, "export.json"), "utf8")).not.toContain("\"words\"");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });
});

// Issue #1019: 語ごとの区間（wordTimes）を log.jsonl の remark の行に残す。
// wordTimes は Remark に入れず、差分更新への入力・スナップショット・書き出しには載らない。wordTimes の無いイベントの行は今までと同じ
describe("SessionSinks（実物 Layer）: 発言の語ごとの区間（Issue #1019）", () => {
  const span = (location: number, length: number, start: number, end: number) => ({ location, length, start, end });
  const remarkLines = (dir: string) => logEvents(dir).filter((e) => e.type === "remark");

  it.effect("wordTimes 付きの確定結果は、log.jsonl の remark の行に wordTimes が残る。remark 自体には入らない", () => {
    const { updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      const wordTimes = [span(0, 2, 1, 1.5), span(2, 1, 1.5, 1.75), span(3, 2, 1.75, 3)];
      yield* sink.final({ track: "相手", start: 1, end: 3, text: "明日の会議", wordTimes });
      yield* sink.drain;
      yield* sink.flush;

      const lines = remarkLines(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0].wordTimes).toEqual(wordTimes);
      expect(lines[0].remark).toEqual({ id: "r1", track: "相手", start: 1, end: 3, text: "明日の会議" });
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("words と wordTimes を両方持つ確定結果の行には、どちらも残る", () => {
    const { updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      const words = [{ surface: "はい", romaji: "hai", location: 0, length: 2 }];
      const wordTimes = [span(0, 2, 0, 1)];
      yield* sink.final({ track: "自分", start: 0, end: 1, text: "はい", words, wordTimes });
      yield* sink.drain;
      yield* sink.flush;

      expect(remarkLines(dir)[0]).toMatchObject({ raw: "はい", words, wordTimes });
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("途中結果から作った発言にも、最後の途中結果の wordTimes が付く", () => {
    const { updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.partial({ track: "相手", start: 5, end: 7.5, text: "あした", duplicate: false, wordTimes: [span(0, 3, 5, 6)] });
      yield* sink.partial({ track: "相手", start: 5, end: 8, text: "あしたの会議", duplicate: false, wordTimes: [span(0, 3, 5, 6), span(3, 1, 6, 6.5), span(4, 2, 6.5, 8)] });
      yield* sink.partial({ track: "自分", start: 0, end: 8 + SETTLE_QUIET_MS / 1000, text: "時計を進める", duplicate: false }); // 自分の途中結果は発言にならず、音声の時計だけを進める
      yield* settle;

      const lines = remarkLines(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0].remark.text).toBe("あしたの会議");
      expect(lines[0].wordTimes).toEqual([span(0, 3, 5, 6), span(3, 1, 6, 6.5), span(4, 2, 6.5, 8)]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("関所が頭を切った発言の行は、wordTimes が切った後の本文の位置に合い、秒は元のまま", () => {
    const { updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.final({ track: "相手", start: 10, end: 12, text: "あいう", wordTimes: [span(0, 3, 10, 12)] });
      yield* sink.final({ track: "相手", start: 11, end: 15, text: "あいうえお", wordTimes: [span(0, 2, 11, 12), span(2, 2, 12, 14), span(4, 1, 14, 15)] });
      yield* sink.drain;
      yield* sink.flush;

      const lines = remarkLines(dir);
      expect(lines.map((e) => [e.remark.id, e.remark.text])).toEqual([["r1", "あいう"], ["r2", "えお"]]);
      // 切る位置は 3。"うえ"（位置 2〜4）は途中で切れるので落ち、"お" は切った後の本文の位置 1 になる
      expect(lines[1].wordTimes).toEqual([span(1, 1, 14, 15)]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  // 字幕: 未反映の発言になっても、表示済みの文字は同じ id の吹き出しに残る（発言の語の時刻を、字幕の盤へ渡す）
  it.effect("途中結果で仮 A・仮 B に分かれて出た文字は、全文が 1 件の未反映の発言になっても、同じ id・同じ文字の 2 つの吹き出しのまま残り、反映後に消える", () => {
    const { calls, updateGate, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, speaks } = yield* openRecordingSink({ speakerOff: false });
      const wordTimes = [span(0, 6, 10, 12), span(6, 5, 12, 14)];
      yield* sink.speaker({ type: "speaker", track: "相手", start: 10, end: 12, slot: 0, final: true });
      yield* sink.speaker({ type: "speaker", track: "相手", start: 12, end: 14, slot: 1, final: false });
      yield* sink.speaker({ type: "speaker-settled", track: "相手", to: 12 });
      yield* sink.partial({ track: "相手", start: 10, end: 14, text: "こんにちは、ありがとう", wordTimes, duplicate: false });
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settleUntil(() => speaks.at(-1)?.bubbles.length === 2 && speaks.at(-1)!.bubbles.every((b) => b.label === "仮"));
      const shown = speaks.at(-1)!.bubbles.map((b) => [b.id, b.text]);
      expect(shown.map(([, text]) => text)).toEqual(["こんにちは、", "ありがとう"]);

      const reply = yield* Deferred.make<void>();
      updateGate.gate = reply; // 差分更新は呼ばれても返らない（発言が未反映のまま）
      yield* sink.final({ track: "相手", start: 10, end: 14, text: "こんにちは、ありがとう", wordTimes });
      yield* sink.speaker({ type: "speaker", track: "相手", start: 10, end: 14, slot: 0, final: true }); // 全文が 1 人の確定区間になる
      yield* sink.speaker({ type: "speaker-settled", track: "相手", to: 14 });
      yield* settleUntil(() => calls.length === 1);
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* settle;

      expect(speaks.at(-1)!.bubbles.map((b) => [b.id, b.text])).toEqual(shown);

      yield* Deferred.succeed(reply, undefined);
      yield* settleUntil(() => lastTexts(speaks, "相手")?.length === 0);
      expect(lastTexts(speaks, "相手")).toEqual([]);
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("wordTimes の無いイベントから作った発言の行には wordTimes のキーが無い", () => {
    const { updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.final({ track: "相手", start: 1, end: 2, text: "確定" });
      yield* sink.partial({ track: "相手", start: 5, end: 6, text: "途中", duplicate: false });
      yield* TestClock.adjust(SETTLE_QUIET_MS);
      yield* settle;
      yield* sink.drain;
      yield* sink.flush;

      const lines = remarkLines(dir);
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(line).not.toHaveProperty("wordTimes");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });

  it.effect("wordTimes は差分更新への入力・書き出しに載らない（Remark の契約は変わらない）", () => {
    const { calls, updaterLayer } = makeRecordingUpdater();
    return Effect.scoped(Effect.gen(function* () {
      const { sink, dir } = yield* openRecordingSink();
      yield* sink.final({ track: "相手", start: 1, end: 3, text: "明日の会議", wordTimes: [span(0, 5, 1, 3)] });
      yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);

      expect(calls.flatMap((c) => c.fresh)[0]).toEqual({ id: "r1", track: "相手", start: 1, end: 3, text: "明日の会議" });
      expect(JSON.stringify(calls)).not.toContain("wordTimes");
      yield* sink.drain;
      yield* sink.flush;
      yield* sink.exports;
      expect(readFileSync(join(dir, "export.json"), "utf8")).not.toContain("wordTimes");
    })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
  });
});

// Issue #640: 利用者が足した語で発言を直す。
// SessionSink の addUserVocabulary(words) が、語を Readings（読みのサブコマンド）にまとめて 1 回渡して読みを作り、
// log.jsonl に vocab の行（表記・読み・出どころ user。読みが無い語は romaji: null）を書いてから、語彙に読みのある語を足す。
// 開始を待たせないため、読みは addUserVocabulary が返った後に非同期で作られる。
// 関所を通った後の本文を補正して発言にする（確定結果・1 秒更新されなかった途中結果・drain のどの出口でも）。途中結果（captions）は直さない。
// 読みの語は実際のトークナイザの出力。remark の行の text は直した本文、raw は直す前の本文、words は直す前の本文の位置のまま
describe("SessionSink: 相手の発言の話者を決める（Issue #1021）", () => {
  const segment = (slot: number, start: number, end: number, final = true) => ({ type: "speaker", track: "相手", start, end, slot, final }) as const;
  const settledAt = (to: number) => ({ type: "speaker-settled", track: "相手", to }) as const;
  const open = () => openRecordingSink({ speakerOff: false });
  type Sink = Effect.Success<ReturnType<typeof openRecordingSink>>["sink"];
  // 自分の途中結果は発言にならず、音声の時計だけを進める
  const tick = (sink: Sink, end: number) => sink.partial({ track: "自分", start: 0, end, text: "時計を進める", duplicate: false });
  const loggedRemarks = (dir: string) => logEvents(dir).filter((e) => e.type === "remark").map((e) => e.remark);
  const brief = (dir: string) => loggedRemarks(dir).map((r) => [r.id, r.speaker, r.text]);

  describe("確定を待って出す", () => {
    it.effect("確定した区間が発言の終わりまで揃うと、ラベルを付けて出る。log.jsonl の行にも差分更新への入力にも同じ話者が載る", () => {
      const { calls, updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* sink.final(finalRemark("相手", 10, 12, "来週に開催します"));
        yield* sink.speaker(segment(2, 10, 11.5));
        yield* sink.speaker(settledAt(11.5));
        yield* settle;
        expect(loggedRemarks(dir)).toEqual([]); // 終わり（12 秒）まで確定していない
        expect(calls).toEqual([]);

        yield* sink.speaker(segment(2, 11.5, 12)); // 区間の end が発言の end に届いても、位置が届くまでは出さない
        yield* settle;
        expect(loggedRemarks(dir)).toEqual([]);

        yield* sink.speaker(settledAt(12));
        yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);

        const expected = { id: "r1", track: "相手", start: 10, end: 12, text: "来週に開催します", speaker: "相手 A" };
        expect(loggedRemarks(dir)).toEqual([expected]);
        expect(calls.flatMap((c) => c.fresh)).toEqual([expected]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

    it.effect("仮の区間（final: false）では揃わない。話者にも使わない", () => {
      const { updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* sink.final(finalRemark("相手", 10, 12, "来週に開催します"));
        yield* sink.speaker(segment(2, 10, 12, false));
        yield* settle;
        expect(loggedRemarks(dir)).toEqual([]);

        yield* tick(sink, 15);
        yield* settle;
        expect(brief(dir)).toEqual([["r1", undefined, "来週に開催します"]]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

    it.effect("3 秒待っても揃わなければ話者なしで出る（3 秒の直前では出ない）。壁時計は進めても数えない。出した後に区間が届いても、行も差分更新への入力も変わらない", () => {
      const { calls, updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* sink.final(finalRemark("相手", 10, 12, "来週に開催します"));

        yield* TestClock.adjust(600_000); // 壁時計では数えない
        yield* tick(sink, 14.999);
        yield* settle;
        expect(loggedRemarks(dir)).toEqual([]);

        yield* tick(sink, 15);
        yield* settleUntil(() => calls.flatMap((c) => c.fresh).length === 1);
        const emitted = { id: "r1", track: "相手", start: 10, end: 12, text: "来週に開催します" };
        expect(loggedRemarks(dir)).toEqual([emitted]);
        expect("speaker" in loggedRemarks(dir)[0]).toBe(false);

        // 出した後に、同じ時間の確定区間が届く
        yield* sink.speaker(segment(2, 10, 12));
        yield* sink.speaker(settledAt(12));
        yield* tick(sink, 30);
        yield* sink.drain;
        yield* sink.flush;
        yield* settle;
        expect(loggedRemarks(dir)).toEqual([emitted]);
        expect(calls.flatMap((c) => c.fresh)).toEqual([emitted]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

    it.effect("文の終わりで締める発言も、ラベルが揃うまで出ない。揃えば待たずに出て、揃わなければ締めた時点から 3 秒で話者なしになる（1 秒の締め切りとは重ならない）", () => {
      const { updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* sink.partial({ track: "相手", start: 10, end: 12.5, text: "お願いします。", duplicate: false });
        yield* tick(sink, 12.55); // 文の終わりから 50ms。ここで発言が締まる（1 秒は経っていない）
        yield* settle;
        expect(loggedRemarks(dir)).toEqual([]); // 締まっても、ラベルが揃うまで出ない

        yield* sink.speaker(segment(2, 10, 12.5)); // 確定した区間が届いても、位置が届くまでは出ない
        yield* settle;
        expect(loggedRemarks(dir)).toEqual([]);
        yield* sink.speaker(settledAt(12.5)); // 位置が届く: 待たずに出る
        yield* settle;
        expect(brief(dir)).toEqual([["r1", "相手 A", "お願いします。"]]);

        // 揃わないとき: 締めた時点（22.55）から 3 秒
        yield* sink.partial({ track: "相手", start: 20, end: 22.5, text: "ありがとうございます。", duplicate: false });
        yield* tick(sink, 22.55);
        yield* tick(sink, 25.549);
        yield* settle;
        expect(loggedRemarks(dir)).toHaveLength(1);
        yield* tick(sink, 25.55);
        yield* settle;
        expect(brief(dir)).toEqual([["r1", "相手 A", "お願いします。"], ["r2", undefined, "ありがとうございます。"]]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

    it.effect("停止（drain）で、保留中の発言は 3 秒を待たずに話者なしで出る", () => {
      const { updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* sink.final(finalRemark("相手", 10, 12, "来週に開催します"));
        yield* settle;
        expect(loggedRemarks(dir)).toEqual([]);

        yield* sink.drain;
        yield* sink.flush;
        yield* settle;

        expect(brief(dir)).toEqual([["r1", undefined, "来週に開催します"]]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });
  });

  describe("話者が替わったところで切る", () => {
    it.effect("1 つの確定結果が 2 人分に切れると r1・r2 になり、次の発言は r3 になる（番号が重ならず飛ばない）。差分更新にも同じ ID・話者で渡る", () => {
      const { calls, updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* sink.speaker(segment(3, 10, 11));
        yield* sink.speaker(segment(1, 11, 14));
        yield* sink.speaker(settledAt(14));
        yield* sink.final({
          track: "相手", start: 10, end: 14, text: "はい、ありがとう",
          wordTimes: [{ location: 0, length: 3, start: 10, end: 11 }, { location: 3, length: 5, start: 11, end: 14 }],
        });
        yield* sink.speaker(segment(1, 20, 22));
        yield* sink.speaker(settledAt(22));
        yield* sink.final(finalRemark("相手", 20, 22, "つぎ"));
        yield* sink.drain;
        yield* sink.flush;
        yield* settle;

        expect(loggedRemarks(dir).map((r) => [r.id, r.speaker, r.text, r.start, r.end])).toEqual([
          ["r1", "相手 A", "はい、", 10, 11],
          ["r2", "相手 B", "ありがとう", 11, 14],
          ["r3", "相手 B", "つぎ", 20, 22],
        ]);
        // r1「はい、」はフィラーだけで中身がないので、ログには残るが差分更新には渡らない（hasContent）
        expect(calls.flatMap((c) => c.fresh).map((r) => [r.id, r.speaker])).toEqual([["r2", "相手 B"], ["r3", "相手 B"]]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });
  });

  describe("ラベル", () => {
    it.effect("初めて話した順に 相手 A・B・C を振り、同じ枠が話せば同じラベル。新しい枠は続きのラベルで、使い回さない。自分は常に「自分」でラベルを消費しない", () => {
      const { updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* sink.final(finalRemark("自分", 0.5, 1, "もしもし")); // 自分が先に話しても、相手の最初が 相手 A
        for (const s of [segment(2, 10, 13), segment(0, 13, 16), segment(2, 16, 19), segment(1, 19, 22), settledAt(22)]) yield* sink.speaker(s);
        yield* sink.final(finalRemark("相手", 10, 13, "ひとつめ"));
        yield* sink.final(finalRemark("相手", 13, 16, "ふたつめ"));
        yield* sink.final(finalRemark("相手", 16, 19, "みっつめ"));
        yield* sink.final(finalRemark("相手", 19, 22, "よっつめ"));
        yield* sink.final(finalRemark("自分", 23, 24, "はい"));
        yield* sink.speaker(segment(0, 25, 27));
        yield* sink.speaker(settledAt(27));
        yield* sink.final(finalRemark("相手", 25, 27, "いつつめ"));
        yield* sink.speaker(segment(5, 40, 42)); // 確定区間が届いただけ（どの発言にも出ていない枠）。ラベルは振らない
        yield* sink.speaker(segment(3, 50, 52));
        yield* sink.speaker(settledAt(52));
        yield* sink.final(finalRemark("相手", 50, 52, "むっつめ"));
        yield* sink.drain;
        yield* sink.flush;
        yield* settle;

        expect(brief(dir)).toEqual([
          ["r1", "自分", "もしもし"],
          ["r2", "相手 A", "ひとつめ"],
          ["r3", "相手 B", "ふたつめ"],
          ["r4", "相手 A", "みっつめ"],
          ["r5", "相手 C", "よっつめ"],
          ["r6", "自分", "はい"],
          ["r7", "相手 B", "いつつめ"],
          ["r8", "相手 D", "むっつめ"],
        ]);
        const valid = new Set<string | undefined>([undefined, "自分", "相手 A", "相手 B", "相手 C", "相手 D"]);
        for (const r of loggedRemarks(dir)) expect(valid.has(r.speaker)).toBe(true);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

    it.effect("最初に話す枠の番号が 7 でも 相手 A になる（枠の番号をそのまま見せない）", () => {
      const { updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* sink.speaker(segment(7, 0, 3));
        yield* sink.speaker(settledAt(3));
        yield* sink.final(finalRemark("相手", 0, 3, "ななばん"));
        yield* settle;

        expect(brief(dir)).toEqual([["r1", "相手 A", "ななばん"]]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });
  });

  describe("speaker-off（話者分離を使えない）", () => {
    it.effect("保留中の発言はすぐ話者なしで出て、以後の相手の発言は待たずに話者なしで出る。先に出した発言のラベルは変わらず、セッションは止まらない", () => {
      const { updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* sink.speaker(segment(2, 0, 3));
        yield* sink.speaker(settledAt(3));
        yield* sink.final(finalRemark("相手", 0, 3, "ラベルあり"));
        yield* sink.final(finalRemark("相手", 10, 12, "保留中"));
        yield* settle;
        expect(brief(dir)).toEqual([["r1", "相手 A", "ラベルあり"]]);

        yield* sink.speaker({ type: "speaker-off", start: 12, reason: "途中で停止" });
        yield* settle;
        expect(brief(dir)).toEqual([["r1", "相手 A", "ラベルあり"], ["r2", undefined, "保留中"]]);

        yield* sink.final(finalRemark("相手", 20, 22, "待たない")); // 時計を進めない
        yield* sink.speaker(segment(2, 20, 30)); // off の後の区間は使わない
        yield* sink.final(finalRemark("相手", 30, 32, "使わない"));
        yield* sink.final(finalRemark("自分", 33, 34, "自分は続く"));
        yield* settle;

        expect(brief(dir)).toEqual([
          ["r1", "相手 A", "ラベルあり"],
          ["r2", undefined, "保留中"],
          ["r3", undefined, "待たない"],
          ["r4", undefined, "使わない"],
          ["r5", "自分", "自分は続く"],
        ]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });
  });

  describe("speaker-mixed（枠への混入。Issue #1024）", () => {
    const mixed = (slot: number, start: number) => ({ type: "speaker-mixed", track: "相手", slot, start }) as const;

    it.effect("戻した枠の、戻した後の発言にはラベルが付かず、前の発言は変わらない。同じ枠が後でまた話しても、会議の最後までラベルは戻らない。差分更新にも同じ話者が渡る", () => {
      const { calls, updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        // 混入の前: 枠 0 が 相手 A、枠 1 が 相手 B
        yield* sink.speaker(segment(0, 10, 13));
        yield* sink.speaker(segment(1, 13, 16));
        yield* sink.speaker(settledAt(16));
        yield* sink.final(finalRemark("相手", 10, 13, "ひとつめ"));
        yield* sink.final(finalRemark("相手", 13, 16, "ふたつめ"));
        yield* settle;
        expect(brief(dir)).toEqual([["r1", "相手 A", "ひとつめ"], ["r2", "相手 B", "ふたつめ"]]);

        // 枠 1 に混入を検出
        yield* sink.speaker(mixed(1, 16));
        yield* settle;
        expect(brief(dir)).toEqual([["r1", "相手 A", "ひとつめ"], ["r2", "相手 B", "ふたつめ"]]); // 前の発言はそのまま

        // 混入の後: 枠 1 の発言は話者なし。枠 0 は 相手 A のまま
        yield* sink.speaker(segment(0, 20, 23));
        yield* sink.speaker(segment(1, 23, 26));
        yield* sink.speaker(settledAt(26));
        yield* sink.final(finalRemark("相手", 20, 23, "みっつめ"));
        yield* sink.final(finalRemark("相手", 23, 26, "よっつめ"));
        yield* settle;

        // さらに後でも、枠 1 のラベルは戻らない
        yield* sink.speaker(segment(1, 30, 33));
        yield* sink.speaker(settledAt(33));
        yield* sink.final(finalRemark("相手", 30, 33, "いつつめ"));
        yield* sink.speaker(segment(1, 40, 43));
        yield* sink.speaker(segment(0, 43, 46));
        yield* sink.speaker(settledAt(46));
        yield* sink.final(finalRemark("相手", 40, 43, "むっつめ"));
        yield* sink.final(finalRemark("相手", 43, 46, "ななつめ"));
        yield* sink.drain;
        yield* sink.flush;
        yield* settle;

        expect(brief(dir)).toEqual([
          ["r1", "相手 A", "ひとつめ"],
          ["r2", "相手 B", "ふたつめ"],
          ["r3", "相手 A", "みっつめ"],
          ["r4", undefined, "よっつめ"],
          ["r5", undefined, "いつつめ"],
          ["r6", undefined, "むっつめ"],
          ["r7", "相手 A", "ななつめ"],
        ]);
        // 話者なしの行には speaker の項目が無い
        for (const r of loggedRemarks(dir).filter((r) => r.speaker === undefined)) expect("speaker" in r).toBe(false);
        // 差分更新への入力: 前の発言の話者は変わらず、戻した後は話者なし
        const fresh = calls.flatMap((c) => c.fresh);
        expect(fresh.map((r) => [r.id, r.speaker])).toEqual([
          ["r1", "相手 A"], ["r2", "相手 B"], ["r3", "相手 A"], ["r4", undefined], ["r5", undefined], ["r6", undefined], ["r7", "相手 A"],
        ]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

    it.effect("戻した枠に区間が挟まれた語も、隣の枠のラベルにならない（区間は取り除かず、ラベルを付ける段で外す）", () => {
      const { updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* sink.speaker(segment(0, 10, 12));
        yield* sink.speaker(settledAt(12));
        yield* sink.final(finalRemark("相手", 10, 12, "ひとつめ"));
        yield* sink.speaker(mixed(1, 12));

        yield* sink.speaker(segment(0, 20, 22));
        yield* sink.speaker(segment(1, 22, 26));
        yield* sink.speaker(segment(0, 26, 28));
        yield* sink.speaker(settledAt(28));
        yield* sink.final({ track: "相手", start: 22, end: 26, text: "まんなか", wordTimes: [{ location: 0, length: 4, start: 22, end: 26 }] });
        yield* sink.drain;
        yield* sink.flush;
        yield* settle;

        expect(brief(dir)).toEqual([["r1", "相手 A", "ひとつめ"], ["r2", undefined, "まんなか"]]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

    it.effect("字幕の仮のラベルも、戻した枠では「なし」になり、他の枠は仮のラベルのまま。混入のイベントで、次の speaker-settled を待たずに字幕が直る", () => {
      const { updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, speaks } = yield* open();
        yield* sink.speaker(segment(1, 10, 11, false));
        yield* sink.speaker(settledAt(11));
        yield* sink.partial({ track: "相手", start: 10, end: 11, text: "あいう", duplicate: false, wordTimes: [{ location: 0, length: 3, start: 10, end: 11 }] });
        yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
        yield* settleUntil(() => speaks.some((f) => f.bubbles.some((b) => b.text.includes("あいう") && b.label === "仮")));
        expect(speaks.at(-1)!.bubbles.map((b) => [b.speaker, b.label])).toEqual([["相手 A", "仮"]]);

        yield* sink.speaker(mixed(1, 11));
        yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
        yield* settleUntil(() => speaks.at(-1)?.bubbles.some((b) => b.label === "なし") === true);

        expect(speaks.at(-1)!.bubbles.map((b) => [b.speaker, b.label, b.text])).toEqual([[undefined, "なし", "あいう"]]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

    it.effect("speaker-mixed は生の値のまま、受け取った順で log.jsonl に at 付きで残る。差分更新の入力には載らない", () => {
      const { calls, updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* sink.speaker(segment(1, 10, 13));
        yield* sink.speaker(mixed(1, 95.5));
        yield* sink.speaker(settledAt(13));
        yield* sink.drain;
        yield* sink.flush;
        yield* settle;

        const rows = logEvents(dir).filter((e) => e.type === "speaker" || e.type === "speaker-mixed" || e.type === "speaker-settled");
        expect(rows.map((e) => e.type)).toEqual(["speaker", "speaker-mixed", "speaker-settled"]);
        const row = logEvents(dir).find((e) => e.type === "speaker-mixed")!;
        expect(typeof row.at).toBe("string");
        const { at, ...rest } = row;
        expect(rest).toEqual({ type: "speaker-mixed", track: "相手", slot: 1, start: 95.5 });
        expect(JSON.stringify(calls)).not.toContain("speaker-mixed");
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });
  });

  // Issue #1025: ヘルパーを起動し直すと Sortformer の枠は振り直される。SessionSink は起動し直しをまたいで同じもの。
  // 起動し直しは sink.speakersRenumbered で起こし、同じ sink の上で「起動し直す前 → 起動し直し → 起動し直した後」を一続きに見る
  describe("起動し直しをまたいだ話者のつなぎ直し（speaker-centroid。Issue #1025）", () => {
    const centroid = (slot: number, vector: readonly number[]) => ({ type: "speaker-centroid", track: "相手", slot, centroid: [...vector] }) as const;
    const mixed = (slot: number, start: number) => ({ type: "speaker-mixed", track: "相手", slot, start }) as const;
    const A = [1, 0, 0];
    const B = [0, 1, 0];
    const FAR = [0, 0, 1];
    const NEAR_A = [0.95, Math.sqrt(1 - 0.95 ** 2), 0];
    const NEAR_B = [Math.sqrt(1 - 0.95 ** 2), 0.95, 0];
    const MID = [0.75, Math.sqrt(1 - 0.75 ** 2), 0];

    // 1 回目のヘルパー: 枠 0 が 相手 A（10〜13）、枠 1 が 相手 B（13〜16）。重心は区間と同じ更新で届く
    const firstRun = (sink: Sink, vectors: { a: readonly number[]; b: readonly number[] } = { a: A, b: B }) =>
      Effect.gen(function* () {
        yield* sink.speaker(segment(0, 10, 13));
        yield* sink.speaker(centroid(0, vectors.a));
        yield* sink.speaker(segment(1, 13, 16));
        yield* sink.speaker(centroid(1, vectors.b));
        yield* sink.speaker(settledAt(16));
        yield* sink.final(finalRemark("相手", 10, 13, "ひとつめ"));
        yield* sink.final(finalRemark("相手", 13, 16, "ふたつめ"));
        yield* settle;
      });
    // 起動し直した後の、ある枠の発言（[start, start + 3] を話した）
    const speak = (sink: Sink, slot: number, start: number, text: string) =>
      Effect.gen(function* () {
        yield* sink.speaker(segment(slot, start, start + 3));
        yield* sink.speaker(settledAt(start + 3));
        yield* sink.final(finalRemark("相手", start, start + 3, text));
        yield* settle;
      });
    const finish = (sink: Sink) =>
      Effect.gen(function* () {
        yield* sink.drain;
        yield* sink.flush;
        yield* settle;
      });

    it.effect("つなぐ: 1 つのラベルとだけ cos 0.9 以上の新しい枠は、枠の番号が前と違っても、そのラベルにつながる。log.jsonl と差分更新の話者も同じ", () => {
      const { calls, updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* firstRun(sink);
        yield* sink.speakersRenumbered;
        yield* sink.speaker(centroid(3, NEAR_B.map((v) => v * 2)));
        yield* speak(sink, 3, 20, "つなぐ");
        yield* finish(sink);

        expect(brief(dir)).toEqual([["r1", "相手 A", "ひとつめ"], ["r2", "相手 B", "ふたつめ"], ["r3", "相手 B", "つなぐ"]]);
        expect(calls.flatMap((c) => c.fresh).map((r) => [r.id, r.speaker])).toEqual([["r1", "相手 A"], ["r2", "相手 B"], ["r3", "相手 B"]]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

    it.effect("新しいラベル: どのラベルとも cos 0.6 未満の新しい枠は、初めて話したときに次のラベルになる。前の世代のラベルと重ならない", () => {
      const { updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* firstRun(sink);
        yield* sink.speakersRenumbered;
        yield* sink.speaker(centroid(0, NEAR_A));
        yield* sink.speaker(centroid(1, FAR));
        yield* speak(sink, 0, 20, "Aに戻る");
        yield* speak(sink, 1, 30, "新しい人");
        yield* finish(sink);

        expect(brief(dir)).toEqual([
          ["r1", "相手 A", "ひとつめ"],
          ["r2", "相手 B", "ふたつめ"],
          ["r3", "相手 A", "Aに戻る"],
          ["r4", "相手 C", "新しい人"],
        ]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

    it.effect("話者なしのまま: 0.6 以上 0.9 未満、または 2 つ以上のラベルと 0.9 以上の新しい枠は、話者なしで出続ける", () => {
      const { updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* firstRun(sink);
        yield* sink.speakersRenumbered;
        yield* sink.speaker(centroid(0, MID));
        yield* speak(sink, 0, 20, "間");
        yield* speak(sink, 0, 30, "まだ間");
        yield* finish(sink);

        expect(brief(dir)).toEqual([["r1", "相手 A", "ひとつめ"], ["r2", "相手 B", "ふたつめ"], ["r3", undefined, "間"], ["r4", undefined, "まだ間"]]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

    it.effect("話者なしのまま: 2 つ以上のラベルと cos 0.9 以上で一致する新しい枠も、話者なしで出る", () => {
      const { updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* firstRun(sink, { a: [1, 0, 0], b: [0.8, 0.6, 0] }); // A と B が近い
        yield* sink.speakersRenumbered;
        const n = Math.hypot(1, 0.3);
        yield* sink.speaker(centroid(0, [1 / n, 0.3 / n, 0])); // A と 約 0.96、B と 約 0.94
        yield* speak(sink, 0, 20, "二人に近い");
        yield* finish(sink);

        expect(brief(dir)).toEqual([["r1", "相手 A", "ひとつめ"], ["r2", "相手 B", "ふたつめ"], ["r3", undefined, "二人に近い"]]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

    it.effect("戻したまま: 混入で戻したラベルに一致する新しい枠は、一致しても話者なしのまま。戻していない別のラベルは付く", () => {
      const { updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* firstRun(sink);
        yield* sink.speaker(mixed(1, 16)); // 相手 B を戻す
        yield* sink.speakersRenumbered;
        yield* sink.speaker(centroid(0, NEAR_B));
        yield* sink.speaker(centroid(1, NEAR_A));
        yield* speak(sink, 0, 20, "戻したBに近い");
        yield* speak(sink, 1, 30, "Aに近い");
        yield* speak(sink, 0, 40, "ずっと戻したまま");
        yield* finish(sink);

        expect(brief(dir)).toEqual([
          ["r1", "相手 A", "ひとつめ"],
          ["r2", "相手 B", "ふたつめ"],
          ["r3", undefined, "戻したBに近い"],
          ["r4", "相手 A", "Aに近い"],
          ["r5", undefined, "ずっと戻したまま"],
        ]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

    it.effect("2 つの枠が同じラベル: 同じラベルに一致する 2 つの新しい枠は、どちらもそのラベルになる", () => {
      const { updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* firstRun(sink);
        yield* sink.speakersRenumbered;
        yield* sink.speaker(centroid(0, NEAR_A));
        yield* sink.speaker(centroid(2, NEAR_A.map((v) => v * 4)));
        yield* speak(sink, 0, 20, "枠ゼロ");
        yield* speak(sink, 2, 30, "枠ふたつ");
        yield* finish(sink);

        expect(brief(dir)).toEqual([["r1", "相手 A", "ひとつめ"], ["r2", "相手 B", "ふたつめ"], ["r3", "相手 A", "枠ゼロ"], ["r4", "相手 A", "枠ふたつ"]]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

    it.effect("照らし合わせが済むまでの発言は話者なしで出て、済んだ後の発言から付く。前の発言は変わらない（log.jsonl も差分更新への入力も）", () => {
      const { calls, updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* firstRun(sink);
        yield* sink.speakersRenumbered;
        // 起動し直した後の枠 0 は、重心が届く前に話す（1 回目の枠 0 は 相手 A だったが、付けない）
        yield* speak(sink, 0, 20, "判定の前");
        expect(brief(dir)).toEqual([["r1", "相手 A", "ひとつめ"], ["r2", "相手 B", "ふたつめ"], ["r3", undefined, "判定の前"]]);

        yield* sink.speaker(centroid(0, NEAR_B));
        yield* speak(sink, 0, 30, "判定の後");
        yield* finish(sink);

        expect(brief(dir)).toEqual([
          ["r1", "相手 A", "ひとつめ"],
          ["r2", "相手 B", "ふたつめ"],
          ["r3", undefined, "判定の前"],
          ["r4", "相手 B", "判定の後"],
        ]);
        expect("speaker" in loggedRemarks(dir)[2]!).toBe(false);
        expect(calls.flatMap((c) => c.fresh).map((r) => [r.id, r.speaker])).toEqual([["r1", "相手 A"], ["r2", "相手 B"], ["r3", undefined], ["r4", "相手 B"]]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

    it.effect("迷っていた枠は、次の重心で照らし合わせ直される。決まった後は、別のラベルに近い重心が届いても替わらない", () => {
      const { updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* firstRun(sink);
        yield* sink.speakersRenumbered;
        yield* sink.speaker(centroid(0, MID));
        yield* speak(sink, 0, 20, "迷い");
        yield* sink.speaker(centroid(0, NEAR_A)); // 決まる
        yield* speak(sink, 0, 30, "決まった");
        yield* sink.speaker(centroid(0, NEAR_B)); // 決まった後は替わらない
        yield* speak(sink, 0, 40, "替わらない");
        yield* sink.speaker(centroid(0, FAR));
        yield* speak(sink, 0, 50, "遠くなっても");
        yield* finish(sink);

        expect(brief(dir).slice(2)).toEqual([["r3", undefined, "迷い"], ["r4", "相手 A", "決まった"], ["r5", "相手 A", "替わらない"], ["r6", "相手 A", "遠くなっても"]]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

    it.effect("起動し直しを 2 回しても、同じ sink の上でラベルが続く（1 回目のラベルにも、2 回目に振ったラベルにもつながる）。ラベルは初めて話した順", () => {
      const { updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* firstRun(sink);
        yield* sink.speakersRenumbered;
        yield* sink.speaker(centroid(0, FAR));
        yield* speak(sink, 0, 20, "三人目");
        yield* sink.speakersRenumbered;
        yield* sink.speaker(centroid(2, NEAR_B));
        yield* sink.speaker(centroid(1, FAR));
        yield* sink.speaker(centroid(3, [0, 0, -1]));
        yield* speak(sink, 2, 30, "Bにつながる");
        yield* speak(sink, 3, 40, "四人目");
        yield* speak(sink, 1, 50, "三人目にもつながる");
        yield* finish(sink);

        expect(brief(dir)).toEqual([
          ["r1", "相手 A", "ひとつめ"],
          ["r2", "相手 B", "ふたつめ"],
          ["r3", "相手 C", "三人目"],
          ["r4", "相手 B", "Bにつながる"],
          ["r5", "相手 D", "四人目"],
          ["r6", "相手 C", "三人目にもつながる"],
        ]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

    it.effect("起動し直したとき、まだ揃っていない保留の発言は話者なしで出て、新しい世代の区間は前の世代の区間と混ざらない", () => {
      const { updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* firstRun(sink);
        yield* sink.final(finalRemark("相手", 20, 22, "揃う前に起動し直し")); // 区間が揃っていない
        yield* settle;
        expect(brief(dir)).toHaveLength(2);

        yield* sink.speakersRenumbered;
        yield* settle;
        expect(brief(dir).slice(2)).toEqual([["r3", undefined, "揃う前に起動し直し"]]);

        yield* sink.speaker(centroid(0, NEAR_A));
        yield* speak(sink, 0, 30, "新しい世代");
        yield* finish(sink);
        expect(brief(dir).slice(3)).toEqual([["r4", "相手 A", "新しい世代"]]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

    it.effect("字幕の仮のラベル: 起動し直した後、照らし合わせが済むまでは「なし」、つながった後は前と同じラベルになる", () => {
      const { updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, speaks } = yield* open();
        yield* firstRun(sink);
        yield* sink.speakersRenumbered;
        yield* sink.speaker(segment(1, 30, 31, false));
        yield* sink.speaker(settledAt(31));
        yield* sink.partial({ track: "相手", start: 30, end: 31, text: "あいう", duplicate: false, wordTimes: [{ location: 0, length: 3, start: 30, end: 31 }] });
        yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
        yield* settleUntil(() => speaks.some((f) => f.bubbles.some((b) => b.text.includes("あいう"))));
        expect(speaks.at(-1)!.bubbles.map((b) => [b.speaker, b.label])).toEqual([[undefined, "なし"]]);

        yield* sink.speaker(centroid(1, NEAR_A));
        yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
        yield* settleUntil(() => speaks.at(-1)?.bubbles.some((b) => b.speaker === "相手 A") === true);

        expect(speaks.at(-1)!.bubbles.map((b) => [b.speaker, b.label, b.text])).toEqual([["相手 A", "仮", "あいう"]]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });

    it.effect("speaker-centroid は生の値のまま、受け取った順で log.jsonl に at 付きで残る。差分更新の入力には載らない。起動し直しの合図は log.jsonl に行を足さない", () => {
      const { calls, updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* sink.speaker(segment(1, 10, 13));
        yield* sink.speaker(centroid(1, [0.25, -0.5, 1]));
        yield* sink.speakersRenumbered;
        yield* sink.speaker(centroid(1, [3, 2, 1]));
        yield* sink.speaker(settledAt(13));
        yield* finish(sink);

        const rows = logEvents(dir).filter((e) => e.type.startsWith("speaker"));
        expect(rows.map((e) => e.type)).toEqual(["speaker", "speaker-centroid", "speaker-centroid", "speaker-settled"]);
        const centroids = rows.filter((e) => e.type === "speaker-centroid");
        expect(centroids.every((e) => typeof e.at === "string")).toBe(true);
        expect(centroids.map(({ at, ...rest }) => rest)).toEqual([
          { type: "speaker-centroid", track: "相手", slot: 1, centroid: [0.25, -0.5, 1] },
          { type: "speaker-centroid", track: "相手", slot: 1, centroid: [3, 2, 1] },
        ]);
        expect(logEvents(dir).map((e) => e.type).filter((t) => t.includes("restart") || t.includes("renumber"))).toEqual([]);
        expect(calls).toEqual([]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });
  });

  describe("log.jsonl", () => {
    it.effect("発言の行に決まった話者が残る。話者なしの行には speaker の項目が無い。speaker の行は先に書かれたまま残る", () => {
      const { updaterLayer } = makeRecordingUpdater();
      return Effect.scoped(Effect.gen(function* () {
        const { sink, dir } = yield* open();
        yield* sink.speaker(segment(4, 0, 3));
        yield* sink.speaker(settledAt(3));
        yield* sink.final(finalRemark("相手", 0, 3, "あいて"));
        yield* sink.final(finalRemark("自分", 4, 5, "じぶん"));
        yield* sink.final(finalRemark("相手", 10, 12, "だれもいない"));
        yield* sink.drain;
        yield* sink.flush;
        yield* settle;

        const rows = loggedRemarks(dir);
        expect(rows).toEqual([
          { id: "r1", track: "相手", start: 0, end: 3, text: "あいて", speaker: "相手 A" },
          { id: "r2", track: "自分", start: 4, end: 5, text: "じぶん", speaker: "自分" },
          { id: "r3", track: "相手", start: 10, end: 12, text: "だれもいない" },
        ]);
        expect(logEvents(dir).filter((e) => e.type === "speaker").map(({ at, ...rest }) => rest)).toEqual([{ type: "speaker", track: "相手", start: 0, end: 3, slot: 4, final: true }]);
        // 確定済みの位置も、生の値のまま残る
        expect(logEvents(dir).filter((e) => e.type === "speaker-settled").map(({ at, ...rest }) => rest)).toEqual([{ type: "speaker-settled", track: "相手", to: 3 }]);
      })).pipe(Effect.provide(sinksLayer({ updaterLayer })));
    });
  });
});
