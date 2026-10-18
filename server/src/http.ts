// ブラウザと CLI からの受け口（上流 ADR 0009）。Origin の制限・タグ付きの失敗からステータスへの対応表・失敗から応答への変換を、この 1 か所に置く。
// 経路の method・path と、本文・応答の Schema は serverProtocol.ts の記述（CLI と共有。上流 ADR 0023）から取る。
//   GET  /apps            ヘルパーの `list` の結果（会議アプリの一覧）を返す
//   POST /session/start   { app, title?, model? } でセッションを開始する
//   POST /session/stop    セッションを終了し、書き出したパスを返す
//   GET  /session/status  取り込みの状態を返す
//   POST /session/resume  止まった状態から起動し直す。成功は 204
//   POST /session/self-pause  { paused: boolean } で自分の休止（true）・再開（false）を求める。成功は 204、本文が違えば 400、セッションが無ければ 409
//   POST /session/speaker-name  { label: string, name: string } で、話者のラベル（相手 B）に名前を手で付ける。成功は 204、本文が違う・名前を付けられないラベル・空の名前は 400、セッションが無ければ 409
//   GET  /check           開始前の確かめ（ヘルパーの check の結果）を返す
//   POST /share/open      閲覧の共有（ADR 0003）を開く。LAN の URL（PIN 付き）を返す（すでに開いていれば今の状態を返す）
//   POST /share/close     閲覧の共有を閉じる（開いていなくても成功する）
//   GET  /share/status    閲覧の共有の状態（無し・共有中）を返す
//   GET  /・/ws           ブラウザへの配信（同じポートで upgrade する）
// /ws の配信には、server から WebSocket の制御フレームの ping を一定の間隔で送る。無通信の接続が切られることへの備えで、
// アプリの JSON フレームは増やさない。間隔の既定は 30 秒で、テストは短い間隔を渡して縮める。
// 閲覧の口（openViewingPort）は、操作の口とは別の、全インターフェース（LAN）の待受けで、GET /（ログを埋め込まない single-file の画面）と
// /ws の配信だけを受ける。PIN（URL の ?pin= → Cookie）で絞り、Origin はその待受け自身（http://<Host>）だけを通し、/session/* などの操作は受けない。
// セッションの操作は sessions.ts の Sessions から受け取り、server.ts の実装は読み込まない（循環依存を作らない）。
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { WebSocket } from "ws";
import { Cause, Context, Effect, Layer, Option, Schema, type Scope } from "effect";
import { HttpRouter, HttpServer, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { NetAddress } from "effect/net";
import type { SessionFailure, SpeakerNameRejected } from "./sessionFailure.ts";
import { Sessions, type SessionStart } from "./sessions.ts";
import { Viewers } from "./viewers.ts";
import { ShareOpenFailed, ViewingShare } from "./viewingShare.ts";
import { ReviewBuild, type ReviewPageFailed } from "./review.ts";
import { Helpers } from "./helpers.ts";
import { ServerRoutes, type SessionStartBody } from "./serverProtocol.ts";
import { defaultClaude } from "./modelSelection.ts";
import { checkReport } from "./startupCheck.ts";

// 本文は decode で既定値が補われているので、実行に渡す形へ詰め替えるだけにする
const toSessionStart = (body: typeof SessionStartBody["Type"]): SessionStart => ({
  app: body.app,
  title: body.title,
  model: body.model ?? defaultClaude,
});

class ForbiddenOrigin extends Schema.TaggedError<ForbiddenOrigin>()("ForbiddenOrigin", {}) {
  override get message(): string {
    return "許可されていない Origin です";
  }
}

// 閲覧の口で、PIN が URL にも Cookie にも無い（または違う）
class PinRequired extends Schema.TaggedError<PinRequired>()("PinRequired", {}) {
  override get message(): string {
    return "PIN が要ります。share が出した URL（?pin= 付き）で開いてください";
  }
}

class UnsupportedRequest extends Schema.TaggedError<UnsupportedRequest>()("UnsupportedRequest", {
  route: Schema.String,
}) {
  override get message(): string {
    return `未対応のリクエスト: ${this.route}`;
  }
}

// 本文の検証に落ちた。文面は Schema（または本文の読み取り）の既定のもの
class InvalidBody extends Schema.TaggedError<InvalidBody>()("InvalidBody", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

// タグ付きの失敗からステータスへの対応。タグが増えたら、ここに足すまで型エラーになる。
// HttpServerError は、上のルート・本文の変換で拾いきれなかったサーバー側の失敗（応答の書き出し等）
type HandledFailure = SessionFailure | SpeakerNameRejected | ShareOpenFailed | ForbiddenOrigin | PinRequired | UnsupportedRequest | InvalidBody | HttpServerError.HttpServerError;

const STATUS: { readonly [Tag in HandledFailure["_tag"]]: number } = {
  InvalidBody: 400,
  SpeakerNameRejected: 400,
  ForbiddenOrigin: 403,
  PinRequired: 403,
  UnsupportedRequest: 404,
  SessionBusy: 409,
  SessionTransition: 409,
  NoSession: 409,
  IntakeNotStopped: 409,
  Aborted: 503,
  RestartGaveUp: 503,
  HelperExited: 500,
  UpdaterUnavailable: 503,
  ShareOpenFailed: 500,
  StartupDepsMissing: 503,
  HttpServerError: 500,
};

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalOrigin(origin: string): boolean {
  return URL.canParse(origin) && LOCAL_HOSTNAMES.has(new URL(origin).hostname);
}

const routeOf = (request: HttpServerRequest.HttpServerRequest): string =>
  `${request.method} ${new URL(request.url, "http://127.0.0.1").pathname}`;

// 127.0.0.1 で待ち受けても、ブラウザ上の任意の Web ページからは接続できてしまう。Origin がローカルのものだけ受理する。
// HTTP と `/`・`/ws` の upgrade の両方に掛ける 1 つのミドルウェア。操作にも upgrade にも進む前に断る
const OriginRestriction = HttpRouter.middleware((httpEffect) =>
  Effect.gen(function* () {
    const { origin } = (yield* HttpServerRequest.HttpServerRequest).headers;
    if (origin !== undefined && !isLocalOrigin(origin)) return yield* new ForbiddenOrigin();
    return yield* httpEffect;
  }), { global: true });

// 記述の本文の Schema で本文を読む。本文が違えば 400
const bodyOf = <A, RD>(schema: Schema.ConstraintDecoder<A, RD>, options?: Parameters<typeof HttpServerRequest.schemaBodyJson>[1]) =>
  HttpServerRequest.schemaBodyJson(schema, options).pipe(Effect.mapError((failure) => new InvalidBody({ detail: failure.message })));

// 記述の response の Schema で成功応答を書き出す。書き出せない（応答の値が Schema に合わない）のは server 側の不具合なので defect にする（500）
const jsonOf = <A>(schema: Schema.ConstraintCodec<A, unknown, unknown, never>) => {
  const encode = HttpServerResponse.schemaJson(schema);
  return (body: A, options?: Parameters<typeof encode>[1]) => encode(body, options).pipe(Effect.orDie);
};

const startSession = Effect.gen(function* () {
  const body = yield* bodyOf(ServerRoutes.sessionStart.body);
  const sessions = yield* Sessions;
  return yield* jsonOf(ServerRoutes.sessionStart.response)(yield* sessions.start(toSessionStart(body)));
});

// ブラウザへの配信。`/ws`（ブラウザ）と `/`（既存のテスト・Vite の proxy の書き換え先）を同じ Viewers で受ける。
// upgrade ではないリクエストは、ルートが無いのと同じ扱いにする
const feed = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const viewers = yield* Viewers;
  const socket = yield* request.upgrade.pipe(
    Effect.mapError(() => new UnsupportedRequest({ route: routeOf(request) })),
  );
  // 切断は配信の終わりで、応答に変える失敗ではない（upgrade 済みなので HTTP の本文は書かれない）
  yield* viewers.connect(socket).pipe(Effect.ignore);
  return HttpServerResponse.empty();
});

const SessionRoutes = HttpRouter.addAll([
  HttpRouter.route(ServerRoutes.apps.method, ServerRoutes.apps.path, Effect.gen(function* () {
    const sessions = yield* Sessions;
    return yield* jsonOf(ServerRoutes.apps.response)(yield* sessions.apps);
  })),
  HttpRouter.route(ServerRoutes.sessionStart.method, ServerRoutes.sessionStart.path, startSession),
  HttpRouter.route(ServerRoutes.sessionStop.method, ServerRoutes.sessionStop.path, Effect.gen(function* () {
    const sessions = yield* Sessions;
    return yield* jsonOf(ServerRoutes.sessionStop.response)(yield* sessions.stop);
  })),
  HttpRouter.route(ServerRoutes.sessionStatus.method, ServerRoutes.sessionStatus.path, Effect.gen(function* () {
    const sessions = yield* Sessions;
    return yield* jsonOf(ServerRoutes.sessionStatus.response)(yield* sessions.status);
  })),
  HttpRouter.route(ServerRoutes.sessionResume.method, ServerRoutes.sessionResume.path, Effect.gen(function* () {
    const sessions = yield* Sessions;
    yield* sessions.resume;
    return HttpServerResponse.empty({ status: 204 });
  })),
  HttpRouter.route(ServerRoutes.sessionSelfPause.method, ServerRoutes.sessionSelfPause.path, Effect.gen(function* () {
    const body = yield* bodyOf(ServerRoutes.sessionSelfPause.body, { onExcessProperty: "error" });
    const sessions = yield* Sessions;
    yield* sessions.setSelfPause(body.paused);
    return HttpServerResponse.empty({ status: 204 });
  })),
  HttpRouter.route(ServerRoutes.sessionSpeakerName.method, ServerRoutes.sessionSpeakerName.path, Effect.gen(function* () {
    const body = yield* bodyOf(ServerRoutes.sessionSpeakerName.body, { onExcessProperty: "error" });
    const sessions = yield* Sessions;
    yield* sessions.setSpeakerName(body);
    return HttpServerResponse.empty({ status: 204 });
  })),
  HttpRouter.route(ServerRoutes.check.method, ServerRoutes.check.path, Effect.gen(function* () {
    const helpers = yield* Helpers;
    return yield* jsonOf(ServerRoutes.check.response)(yield* checkReport(helpers.check));
  })),
]);

const ShareRoutes = HttpRouter.addAll([
  HttpRouter.route(ServerRoutes.shareOpen.method, ServerRoutes.shareOpen.path, Effect.gen(function* () {
    const share = yield* ViewingShare;
    return yield* jsonOf(ServerRoutes.shareOpen.response)(yield* share.open);
  })),
  HttpRouter.route(ServerRoutes.shareClose.method, ServerRoutes.shareClose.path, Effect.gen(function* () {
    const share = yield* ViewingShare;
    yield* share.close;
    return yield* jsonOf(ServerRoutes.shareClose.response)(yield* share.status);
  })),
  HttpRouter.route(ServerRoutes.shareStatus.method, ServerRoutes.shareStatus.path, Effect.gen(function* () {
    const share = yield* ViewingShare;
    return yield* jsonOf(ServerRoutes.shareStatus.response)(yield* share.status);
  })),
]);

// サーバー自身への終了の求め（/server/stop）の伝え先。main（server.ts）が、待っている Deferred を解く関数を渡す。
// 既定は何もしない（テストが in-process で起こす startup。そこでは Scope を閉じて止める）
export const ServerControl = Context.Reference("live-mindmap/ServerControl", {
  defaultValue: () => ({ onStopRequested: (): void => {} }),
});
// 204 を返してから後片付けを始めるための猶予。求めは別のファイバーに切り離して伝える（待受けを閉じても応答を書き終えられる）
const STOP_RESPONSE_GRACE_MS = 100;

const ServerIdentityRoutes = HttpRouter.addAll([
  HttpRouter.route(ServerRoutes.server.method, ServerRoutes.server.path, Effect.suspend(() => jsonOf(ServerRoutes.server.response)({ pid: process.pid }))),
  HttpRouter.route(ServerRoutes.serverStop.method, ServerRoutes.serverStop.path, Effect.gen(function* () {
    const control = yield* ServerControl;
    yield* Effect.forkDetach(Effect.sleep(STOP_RESPONSE_GRACE_MS).pipe(Effect.andThen(Effect.sync(control.onStopRequested))));
    return HttpServerResponse.empty({ status: 204 });
  })),
]);

const FeedRoutes = HttpRouter.addAll([
  HttpRouter.route(ServerRoutes.feed.method, ServerRoutes.feed.path, feed),
  HttpRouter.route("GET", "/", feed),
]);

// どのルートにも当たらなかったときの応答。ルートが無い場合の文面を 1 か所で持つ
const UnsupportedRoute = HttpRouter.addAll([
  HttpRouter.route("*", "*", Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* new UnsupportedRequest({ route: routeOf(request) });
  })),
]);

const failureMessage = (value: unknown): string => (value instanceof Error ? value.message : String(value));

// 失敗を応答に変える 1 か所。タグ付きの失敗は上の表のステータスと文面、表にない失敗と defect は
// causeResponse のステータス（500）で、文面は伏せずに返す。中断はこの変換に持ち込まず、
// サーバー側の既定の扱いへ渡す
const respond = <R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, HandledFailure, R>) =>
  Effect.catchCauseIf(
    handler,
    (cause) => !Cause.hasInterrupts(cause),
    (cause) =>
      Effect.gen(function* () {
        const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
        if (failure !== undefined) {
          if (failure._tag === "StartupDepsMissing") {
            return HttpServerResponse.jsonUnsafe({ _tag: failure._tag, items: failure.items, error: failure.message }, { status: STATUS[failure._tag] });
          }
          return HttpServerResponse.jsonUnsafe({ error: failure.message }, { status: STATUS[failure._tag] });
        }
        const [response] = yield* HttpServerError.causeResponse(cause);
        return HttpServerResponse.jsonUnsafe({ error: failureMessage(Cause.squash(cause)) }, { status: response.status });
      }),
  );

export const portOf = (address: NetAddress.SocketAddress): Effect.Effect<number> =>
  address._tag === "UnixPathAddress" ? Effect.die(new Error("TCP のポートで待ち受けていない")) : Effect.succeed(address.port);

// close フレームを送った接続が応答しない場合、ws の既定（CLOSE_TIMEOUT）は 30,000ms 待ってから
// raw socket を切断する。これは終了処理にとって実質無期限で、応答しない接続が 1 本でもあると
// close() の所要時間がその接続に縛られる。close ハンドシェイクは同一プロセス内の 1 往復
// （数十 ms 未満）で終わるのが通常なので、ヘルパーの SIGTERM→SIGKILL の猶予
// （helpers.ts の HELPER_STOP_TIMEOUT_MS=5,000ms）と同程度を上限にすれば、正常系を妨げずに
// 応答しない接続を打ち切れる
const WS_CLOSE_TIMEOUT_MS = 3_000;

// /ws の配信への ping の間隔の既定（ms）
export const FEED_PING_INTERVAL_MS = 30_000;

// 接続ごとに、一定の間隔で制御フレームの ping を送るサーバー側 WebSocket のクラス。
// effect の Socket は制御フレームを送る手段を持たず、生の ws に手が届くのは WebSocketServer の WebSocket オプションだけなので、
// ws の WebSocket を継承してここで差し込む。タイマーは接続の寿命に結び、close で止める（unref で、タイマーだけがプロセスを生かさない）
const pingingWebSocket = (intervalMs: number) =>
  class PingingWebSocket extends WebSocket {
    readonly #pinger = (() => {
      const timer = setInterval(() => {
        if (this.readyState === WebSocket.OPEN) this.ping();
      }, intervalMs);
      timer.unref();
      this.once("close", () => clearInterval(timer));
      return timer;
    })();
  };

// @types/ws@8.18 の ServerOptions は closeTimeout を宣言していないが、ws@8.22 のランタイムは
// WebSocketServer のオプションとしてそのまま受け取り、各サーバー側 WebSocket の _closeTimeout へ伝える
// （ws/lib/websocket-server.js の completeUpgrade → new this.options.WebSocket(...) で options ごと渡る）。
// 型定義の遅れを、この 1 フィールドだけの型アサーションで補う（any にはしない）
const websocketOptions = (pingIntervalMs: number) =>
  ({ closeTimeout: WS_CLOSE_TIMEOUT_MS, WebSocket: pingingWebSocket(pingIntervalMs) }) as NodeHttpServer.Options["websocket"];

// host で待ち受ける（操作の口は 127.0.0.1、閲覧の口は全インターフェース）。port が 0 なら空きポート。
// NodeHttpServer は Node の http.Server を引数に取るので、node:http への参照はここ 1 か所に閉じる。
// disablePreemptiveShutdown: Scope を閉じたら、まず要求の処理を止めて接続中の Fiber を終わらせ、
// その後に待受けを閉じる。既定の猶予つき停止は、接続が残っている間 20 秒待ってから諦めるため、
// 終了が 20 秒遅れる（close() は時間内に戻ることを既存のテストが確かめている）
const layerNodeServer = (port: number, host: string, pingIntervalMs: number) =>
  NodeHttpServer.layer(createServer, { port, host, disablePreemptiveShutdown: true, websocket: websocketOptions(pingIntervalMs) });

// 配信（Viewers）と待受け（HttpServer）の Layer。Scope を閉じると待受けが閉じる
export const layerListener = (port: number, pingIntervalMs: number = FEED_PING_INTERVAL_MS): Layer.Layer<Viewers | HttpServer.HttpServer, HttpServerError.ServeError> =>
  Layer.mergeAll(Viewers.layer, layerNodeServer(port, "127.0.0.1", pingIntervalMs));

// layerListener を、いまの Scope に結び付けて作る。serveFeed・serveSessions へ渡す Viewers と HttpServer の Context を返す
// （port は HttpServer の address から portOf で読む）
export const openListener = (port: number, pingIntervalMs: number = FEED_PING_INTERVAL_MS) => Layer.build(layerListener(port, pingIntervalMs));

// ブラウザへの配信だけを受ける（CLI の再生）。待ち受けているポートは HttpServer の address から読む
export const serveFeed: Effect.Effect<void, never, HttpServer.HttpServer | Viewers | Scope.Scope> = Effect.flatMap(
  HttpRouter.toHttpEffect(Layer.mergeAll(FeedRoutes, UnsupportedRoute, OriginRestriction)),
  (handler) => HttpServer.serveEffect(respond(handler)),
);

// セッションの操作と配信を受ける（常駐サーバー）
export const serveSessions: Effect.Effect<void, never, HttpServer.HttpServer | Sessions | ViewingShare | Helpers | Viewers | Scope.Scope> = Effect.flatMap(
  HttpRouter.toHttpEffect(Layer.mergeAll(SessionRoutes, ShareRoutes, ServerIdentityRoutes, FeedRoutes, UnsupportedRoute, OriginRestriction)),
  (handler) => HttpServer.serveEffect(respond(handler)),
);

// 閲覧の口の Cookie。値は PIN そのもの
export const VIEW_COOKIE = "mindmap-view";

// 閲覧の口（ADR 0003）。操作の口とは別の、全インターフェース（LAN）の待受け（port 0 で空きポート）で、GET /（ログを埋め込まない
// single-file の画面）と /ws の配信だけを受ける。配信は呼び出し側の Viewers を使う（保持値と PubSub を複製しない）。待受けは呼び出し側の Scope で閉じる。
// 絞り: GET / は ?pin= が合えば Cookie に写して画面を返し、Cookie が合えば画面を返す。どちらも無ければ 403。
// /ws は Cookie が合い、かつ Origin がこの待受け自身（http://<Host>）のときだけ通す（Origin が無くても断る）。
// Origin のある要求は、どのパスでも Origin が http://<Host> と一致しなければ 403（別の Web ページからの接続を断る）。
// 画面のビルドは開くときに 1 回だけ行う（Vite の開発用サーバーは使わない）
export const openViewingPort = (port: number, pin: string, pingIntervalMs: number = FEED_PING_INTERVAL_MS): Effect.Effect<number, HttpServerError.ServeError | ReviewPageFailed, Viewers | ReviewBuild | Scope.Scope> =>
  Effect.gen(function* () {
    const { build } = yield* ReviewBuild;
    const page = yield* build;
    const pinMatches = (value: string | undefined) => value !== undefined && value.length === pin.length && timingSafeEqual(Buffer.from(value), Buffer.from(pin));
    const SameHostOrigin = HttpRouter.middleware((httpEffect) =>
      Effect.gen(function* () {
        const { origin, host } = (yield* HttpServerRequest.HttpServerRequest).headers;
        if (origin !== undefined && (host === undefined || origin !== `http://${host}`)) return yield* new ForbiddenOrigin();
        return yield* httpEffect;
      }), { global: true });
    const routes = HttpRouter.addAll([
      HttpRouter.route("GET", "/ws", Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.headers.origin === undefined) return yield* new ForbiddenOrigin();
        if (!pinMatches(request.cookies[VIEW_COOKIE])) return yield* new PinRequired();
        return yield* feed;
      })),
      HttpRouter.route("GET", "/", Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const response = HttpServerResponse.text(page, { contentType: "text/html; charset=utf-8" });
        const given = new URL(request.url, "http://127.0.0.1").searchParams.get("pin") ?? undefined;
        if (pinMatches(given)) return yield* HttpServerResponse.setCookie(VIEW_COOKIE, pin, { path: "/", httpOnly: true, sameSite: "lax" })(response).pipe(Effect.orDie);
        if (pinMatches(request.cookies[VIEW_COOKIE])) return response;
        return yield* new PinRequired();
      })),
    ]);
    const context = yield* Layer.build(layerNodeServer(port, "0.0.0.0", pingIntervalMs));
    const handler = yield* HttpRouter.toHttpEffect(Layer.mergeAll(routes, UnsupportedRoute, SameHostOrigin));
    yield* HttpServer.serveEffect(respond(handler)).pipe(Effect.provide(context));
    return yield* portOf(Context.get(context, HttpServer.HttpServer).address);
  });
