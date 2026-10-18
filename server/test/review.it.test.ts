import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { mapOnlyReviewEvents } from "../src/core/index.ts";
import { ReviewBuild, ReviewPageFailed, writeReviewPages } from "../src/review.ts";
import { embeddedText, TEMPLATE } from "./fixtures/review.ts";

// 書き出し（writeReviewPages）が、本物のファイルシステムで HTML を書くこと。ビルドだけ偽物にする。埋め込み単体の確認は review.test.ts

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-review-test-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

// 書き出し（ログの読み込み・HTML の書き込み）は本物の FileSystem で、ビルドだけ偽物にする
const fakeBuild = (build: Effect.Effect<string, ReviewPageFailed>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provideService(ReviewBuild, ReviewBuild.of({ build })), Effect.provide(NodeFileSystem.layer));

const PLAIN = { file: "map.html" } as const;
const MAP_ONLY = { file: "map-only.html", mapOnly: true } as const;

describe("writeReviewPages", () => {
  it.effect("log.jsonl の出来事（空行は除く・行末の改行あり）を、版ごとに 1 つの HTML へ埋め込んで書き、パスを版の順に返す。ビルドは 1 回だけ", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const events = [{ at: "a", type: "start", title: "定例" }, { at: "b", type: "intake", note: "x" }];
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath, `${JSON.stringify(events[0])}\n\n${JSON.stringify(events[1])}\n`);
    let builds = 0;

    const { paths } = yield* writeReviewPages(dir, logPath, [PLAIN, { file: "second.html" }]).pipe(
      fakeBuild(Effect.sync(() => { builds++; return TEMPLATE; })),
    );

    expect(paths).toEqual([join(dir, "map.html"), join(dir, "second.html")]);
    expect(builds).toBe(1);
    for (const path of paths) {
      const html = yield* Effect.tryPromise(() => readFile(path, "utf8"));
      expect(JSON.parse(embeddedText(html))).toEqual(events);
    }
  }));

  it.effect("ビルドが失敗したら ReviewPageFailed になり、何も書かない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath, `${JSON.stringify({ type: "start", title: "t" })}\n`);

    const result = yield* Effect.result(
      writeReviewPages(dir, logPath, [PLAIN]).pipe(fakeBuild(Effect.fail(new ReviewPageFailed({ message: "ビルドに失敗" })))),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ReviewPageFailed);
      expect(result.failure.message).toContain("ビルドに失敗");
    }
    expect(existsSync(join(dir, "map.html"))).toBe(false);
  }));

  it.effect("読めない行があれば ReviewPageFailed にし、「<path> の <n> 行目が JSON として読めません: <1 行の理由>」とする。行番号は空行を除く前に数える。HTML は書かない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath, `${JSON.stringify({ type: "start", title: "t" })}\n\n{broken\n`);

    const result = yield* Effect.result(writeReviewPages(dir, logPath, [PLAIN]).pipe(fakeBuild(Effect.succeed(TEMPLATE))));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ReviewPageFailed);
      const prefix = `${logPath} の 3 行目が JSON として読めません: `;
      expect(result.failure.message.startsWith(prefix)).toBe(true);
      expect(result.failure.message.slice(prefix.length)).toMatch(/^[^\n]+$/);
    }
    expect(existsSync(join(dir, "map.html"))).toBe(false);
  }));

  it.effect("テンプレートに </body> が無ければ ReviewPageFailed になる", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath, `${JSON.stringify({ type: "start", title: "t" })}\n`);

    const result = yield* Effect.result(writeReviewPages(dir, logPath, [PLAIN]).pipe(fakeBuild(Effect.succeed("<html></html>"))));

    expect(Result.isFailure(result) && result.failure instanceof ReviewPageFailed).toBe(true);
    expect(existsSync(join(dir, "map.html"))).toBe(false);
  }));
});

describe("writeReviewPages のマップだけの版", () => {
  it.effect("mapOnly の版には発言の文字を抜いた出来事を、mapOnly のない版には元の出来事をそのまま埋め込む。ビルドは 1 回だけ", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const events = [
      { at: "a", type: "start", title: "定例" },
      { at: "b", type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 5, text: "給与は九百万です" }, raw: "きゅうよは九百万です" },
    ];
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
    let builds = 0;

    const { paths } = yield* writeReviewPages(dir, logPath, [PLAIN, MAP_ONLY]).pipe(
      fakeBuild(Effect.sync(() => { builds++; return TEMPLATE; })),
    );

    expect(paths).toEqual([join(dir, "map.html"), join(dir, "map-only.html")]);
    expect(builds).toBe(1);
    const plain = yield* Effect.tryPromise(() => readFile(paths[0]!, "utf8"));
    const mapOnly = yield* Effect.tryPromise(() => readFile(paths[1]!, "utf8"));
    expect(JSON.parse(embeddedText(plain))).toEqual(events);
    expect(JSON.parse(embeddedText(mapOnly))).toEqual(mapOnlyReviewEvents(events));
    for (const secret of ["給与は九百万です", "きゅうよは九百万です"]) {
      expect(plain).toContain(secret);
      expect(mapOnly).not.toContain(secret);
    }
  }));

  it.effect("mapOnly の版で、壊れた発言の行があれば ReviewPageFailed になり、何も書かない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath, `${JSON.stringify({ type: "start", title: "t" })}\n${JSON.stringify({ type: "remark", note: "給与は九百万です" })}\n`);

    const result = yield* Effect.result(
      writeReviewPages(dir, logPath, [PLAIN, MAP_ONLY]).pipe(fakeBuild(Effect.succeed(TEMPLATE))),
    );

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(ReviewPageFailed);
    expect(existsSync(join(dir, "map.html"))).toBe(false);
    expect(existsSync(join(dir, "map-only.html"))).toBe(false);
  }));
});
