// 閲覧の口（http.ts の openViewingPort。ADR 0003）の IT。本物のソケットで、別の待受けが
// 静的な画面（ログを埋め込まない single-file ビルド）と /ws の配信だけを、PIN（URL → Cookie）と自分の Origin にだけ通すことを確かめる。
// 配信は操作の口（serveFeed）と同じ Viewers の実体を使う。待受けは全インターフェースだが、ここでは 127.0.0.1 から叩く。
import { describe, expect, it, vi } from "@effect/vitest";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { HttpServer } from "effect/http";
import { WebSocket } from "ws";
import { openListener, openViewingPort, portOf, serveFeed, VIEW_COOKIE } from "../src/http.ts";
import { ReviewBuild } from "../src/review.ts";
import { Viewers } from "../src/viewers.ts";
import { TEMPLATE } from "./fixtures/review.ts";
import { connect } from "./fixtures/wsClient.ts";

const PIN = "012345";
const fakeBuild = Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed(TEMPLATE) }));
const snapshot = { nodes: [], round: 1, changes: [], remarks: [] };

// 操作の口（serveFeed）と閲覧の口を、同じ Viewers で立てる。閲覧の口だけを閉じられる Scope を別に持つ
const ports = Effect.fnUntraced(function* () {
  const ctx = yield* openListener(0);
  const viewers = Context.get(ctx, Viewers);
  const operationPort = yield* portOf(Context.get(ctx, HttpServer.HttpServer).address);
  yield* Effect.provide(serveFeed, ctx);
  const viewingScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void));
  const viewingPort = yield* openViewingPort(0, PIN).pipe(
    Effect.provide(Layer.merge(Layer.succeed(Viewers, viewers), fakeBuild)),
    Scope.provide(viewingScope),
  );
  const self = `http://127.0.0.1:${viewingPort}`; // この待受け自身の Origin
  const cookie = { cookie: `${VIEW_COOKIE}=${PIN}` };
  return { viewers, operationPort, viewingPort, viewingScope, self, cookie };
});

const get = (port: number, path: string, headers: Record<string, string> = {}, method = "GET") =>
  Effect.tryPromise(() => fetch(`http://127.0.0.1:${port}${path}`, { method, headers, redirect: "manual" }));

// upgrade が断られたときの HTTP ステータス。upgrade できてしまったら 101 を返す
const upgradeStatus = (port: number, path: string, origin: string | undefined, headers: Record<string, string> = {}) =>
  Effect.tryPromise(() => new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, ...(origin === undefined ? {} : { origin }) });
    ws.once("unexpected-response", (_req, res) => { res.resume(); resolve(res.statusCode ?? 0); });
    ws.once("open", () => { ws.terminate(); resolve(101); });
    ws.once("error", reject);
  }));

describe("閲覧の口（ADR 0003）", () => {
  it.live("GET /?pin= が合えば、画面を text/html で返し、PIN を Cookie に写す。以後は Cookie だけで画面が返る", () => Effect.gen(function* () {
    const p = yield* ports();
    const first = yield* get(p.viewingPort, `/?pin=${PIN}`);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toMatch(/^text\/html/);
    expect(yield* Effect.tryPromise(() => first.text())).toBe(TEMPLATE);
    expect(first.headers.get("set-cookie")).toMatch(new RegExp(`^${VIEW_COOKIE}=${PIN};`));
    expect(first.headers.get("set-cookie")).toContain("HttpOnly");
    const second = yield* get(p.viewingPort, "/", p.cookie);
    expect(second.status).toBe(200);
    expect(second.headers.get("set-cookie")).toBeNull();
    expect(yield* Effect.tryPromise(() => second.text())).toBe(TEMPLATE);
  }));

  it.live("PIN が無い・違うときは GET / も /ws も 403。Cookie が違っても 403", () => Effect.gen(function* () {
    const p = yield* ports();
    expect((yield* get(p.viewingPort, "/")).status).toBe(403);
    expect((yield* get(p.viewingPort, "/?pin=999999")).status).toBe(403);
    expect((yield* get(p.viewingPort, "/?pin=01234")).status).toBe(403);
    expect((yield* get(p.viewingPort, "/", { cookie: `${VIEW_COOKIE}=999999` })).status).toBe(403);
    // 間違った PIN は Cookie に写さない
    expect((yield* get(p.viewingPort, "/?pin=999999")).headers.get("set-cookie")).toBeNull();
    expect(yield* upgradeStatus(p.viewingPort, "/ws", p.self)).toBe(403);
    expect(yield* upgradeStatus(p.viewingPort, "/ws", p.self, { cookie: `${VIEW_COOKIE}=999999` })).toBe(403);
    // /ws は URL の ?pin= では通らない（Cookie だけ）
    expect(yield* upgradeStatus(p.viewingPort, `/ws?pin=${PIN}`, p.self)).toBe(403);
  }));

  it.live("/ws は Cookie が合い、Origin がこの待受け自身のときだけ通る。Origin が無い・別の Origin は 403", () => Effect.gen(function* () {
    const p = yield* ports();
    expect(yield* upgradeStatus(p.viewingPort, "/ws", p.self, p.cookie)).toBe(101);
    expect(yield* upgradeStatus(p.viewingPort, "/ws", undefined, p.cookie)).toBe(403);
    for (const origin of ["http://evil.example", "null", `https://127.0.0.1:${p.viewingPort}`, `http://127.0.0.1:${p.operationPort}`, `${p.self}/`, "http://localhost:5173"]) {
      expect([origin, yield* upgradeStatus(p.viewingPort, "/ws", origin, p.cookie)]).toEqual([origin, 403]);
      // Origin のある GET / も、別の Origin なら断る（別の Web ページからの読み出し）
      expect([origin, (yield* get(p.viewingPort, "/", { ...p.cookie, origin })).status]).toEqual([origin, 403]);
    }
    expect((yield* get(p.viewingPort, "/", { ...p.cookie, origin: p.self })).status).toBe(200);
  }));

  it.live("/ と /ws 以外のパス・メソッドは断る（/session/*・/apps・/check・POST /・/index.html）", () => Effect.gen(function* () {
    const p = yield* ports();
    const refused = [
      ...["start", "stop", "status", "resume", "self-pause", "speaker-name"].flatMap((name) => ["GET", "POST"].map((m) => [m, `/session/${name}`] as const)),
      ["GET", "/apps"], ["GET", "/check"], ["GET", "/share/status"], ["POST", "/share/open"], ["POST", "/"], ["GET", "/index.html"], ["POST", "/ws"],
    ] as const;
    for (const [method, path] of refused) {
      const response = yield* get(p.viewingPort, path, p.cookie, method);
      expect([method, path, response.status]).toEqual([method, path, 404]);
    }
  }));

  it.live("つないだら保持している値が先に届き、その後の publish は操作の口と閲覧の口の両方へ届く（同じ Viewers）", () => Effect.gen(function* () {
    const p = yield* ports();
    yield* p.viewers.publish(snapshot);
    const viewing = yield* connect(p.viewingPort, "/ws", p.self, p.cookie);
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(viewing.frames).toHaveLength(1)));
    const operation = yield* connect(p.operationPort, "/ws", undefined);
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(operation.frames).toHaveLength(1)));
    const next = { ...snapshot, round: 2 };
    yield* p.viewers.publish(next);
    yield* Effect.tryPromise(() => vi.waitFor(() => {
      expect(viewing.frames.at(-1)).toEqual(next);
      expect(operation.frames.at(-1)).toEqual(next);
    }));
  }));

  it.live("Scope を閉じると閲覧の口は閉じ、操作の口は動き続ける", () => Effect.gen(function* () {
    const p = yield* ports();
    expect((yield* get(p.viewingPort, "/", p.cookie)).status).toBe(200);
    yield* Scope.close(p.viewingScope, Exit.void);
    yield* Effect.tryPromise(() => expect(fetch(`http://127.0.0.1:${p.viewingPort}/`)).rejects.toThrow());
    yield* p.viewers.publish(snapshot);
    const operation = yield* connect(p.operationPort, "/ws", undefined);
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(operation.frames).toEqual([snapshot])));
  }));
});
