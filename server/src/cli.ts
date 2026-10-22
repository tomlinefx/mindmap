#!/usr/bin/env node
// mindmap の CLI。AI エージェントが Bash から呼ぶ（上流 ADR 0003）。
// 使い方は各 Command・Flag の withDescription が正本で、`live-mindmap --help` で読む（上流 ADR 0010）。
import { basename, join, resolve } from "node:path";
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, DateTime, Effect, FileSystem, Layer, Option, PlatformError, Predicate, Result, Schedule, Schema, type Runtime } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import { Argument, Command, Flag } from "effect/cli";
import { portConfig, sessionsDirConfig } from "./config.ts";
import { withoutFinalNewline } from "./consoleText.ts";
import { prepareUpdaterLayer } from "./diffUpdater.ts";
import { UpdaterUnavailable } from "./updaterUnavailable.ts";
import { claudeModel, type ExecutableModel } from "./modelSelection.ts";
import {
  formatIntakeStatus,
  formatShareOpened,
  formatShareStatus,
  formatLatencyTable,
  formatTable,
  DiffEvent,
  DiffUpdater,
  fromTranscript,
  JsonExport,
  latencyReport,
  LogEvent,
  RemarkEvent,
  StartEvent,
  SessionLog,
  playback,
  type PlaybackRemark,
  restoreSession,
  restoreState,
  toMarkdown,
  TranscriptFile,
  type IntakeStatusReport,
  type Run,
  type Snapshot,
  type DiffUpdateFrame,
} from "./core/index.ts";
import { openListener, serveFeed } from "./http.ts";
import { BrokenLogLine, readLogLines } from "./logLines.ts";
import { ReviewBuild } from "./review.ts";
import { createSessionDir, EXPORT_FILE, LOG_FILE, openLoggedSession, REVIEW_FILE, reviewWarning, writeReview, writeSessionExports } from "./sessionFiles.ts";
import { describe, fileReason, formatIssues, InvalidTruthFile, oneLine, readScreenTruthFile, readTextFile, readTruthFile } from "./truthFile.ts";
import { Viewers } from "./viewers.ts";
import { ServerRoutes, type ServerRoute } from "./serverProtocol.ts";
import { isMissing, StartupDepsMissing } from "./startupCheck.ts";
import { exitCodeTeardown, reportEntryFailure } from "./entryFailure.ts";
import { planServerStop, readServerPid, removeServerPid, ServerProcess } from "./serverProcess.ts";

// server/package.json は private で version を持たないので、--version の正本はここに置く
const VERSION = "0.1.0";

/* ----------------------------------------------------------------------------
 * 失敗: サブコマンドの中身の失敗はタグ付きにし、入口の表 1 つで日本語の 1 行に変える
 * -------------------------------------------------------------------------- */

class ServerUnreachable extends Schema.TaggedError<ServerUnreachable>()("ServerUnreachable", {}) {}
class ServerFailed extends Schema.TaggedError<ServerFailed>()("ServerFailed", { message: Schema.String }) {}
class RequiredDepsMissing extends Schema.TaggedError<RequiredDepsMissing>()("RequiredDepsMissing", {}) {}
class NoSession extends Schema.TaggedError<NoSession>()("NoSession", { sessionsDir: Schema.String }) {}
class MissingRunExport extends Schema.TaggedError<MissingRunExport>()("MissingRunExport", { path: Schema.String }) {}
class InvalidTranscriptFile extends Schema.TaggedError<InvalidTranscriptFile>()("InvalidTranscriptFile", {
  path: Schema.String,
  reason: Schema.String,
}) {}
// 下位のモジュール（配信・再生・ファイルの読み書き）の失敗。message はそのまま入口の 1 行になる
class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", { message: Schema.String }) {}

// ログの行を type で選ぶ集合（decode は LogEvent のまま）
const typesOf = (events: readonly { readonly fields: { readonly type: { readonly literal: string } } }[]): ReadonlySet<string> => new Set(events.map((event) => event.fields.type.literal));
const hasLoggedType = (types: ReadonlySet<string>) => (event: unknown): event is { readonly type: string } =>
  Predicate.isObject(event) && "type" in event && Predicate.isString(event.type) && types.has(event.type);
// セッションのフォルダを再生するとき（題名・発言）
const isReplayedEvent = hasLoggedType(typesOf([StartEvent, RemarkEvent]));
// evaluate が読むとき（題名・発言・差分）
const isEvalEvent = hasLoggedType(typesOf([StartEvent, RemarkEvent, DiffEvent]));

// 入口で 1 行にする失敗の class
const CLI_FAILURES = [
  ServerUnreachable,
  ServerFailed,
  NoSession,
  MissingRunExport,
  InvalidTruthFile,
  InvalidTranscriptFile,
  BrokenLogLine,
  CommandFailed,
  UpdaterUnavailable,
] as const;
type CliFailure = InstanceType<(typeof CLI_FAILURES)[number]>;

// 入口の表。タグ付きの失敗を、今までと同じ日本語の 1 行にする（表示はここだけが持つ）
const failureLine = (failure: CliFailure): string => {
  switch (failure._tag) {
    case "ServerUnreachable":
      return "サーバーにつながりません（pnpm dev で起動）";
    case "ServerFailed":
      return failure.message;
    case "NoSession":
      return `セッションがありません: ${failure.sessionsDir}`;
    case "MissingRunExport":
      return `セッションのマップがありません: ${failure.path}`;
    case "InvalidTruthFile":
      return `正解ファイルが不正です: ${failure.path}（${failure.reason}）`;
    case "InvalidTranscriptFile":
      return `文字起こしファイルが不正です: ${failure.path}（${failure.reason}）`;
    case "BrokenLogLine":
      return `${LOG_FILE} の ${failure.line} 行目が JSON として読めません: ${failure.reason}`;
    case "CommandFailed":
    case "UpdaterUnavailable":
      return failure.message;
  }
};

const isCliFailure = (failure: unknown): failure is CliFailure => CLI_FAILURES.some((C) => failure instanceof C);

// decode の失敗を 1 行の理由にする。[配列の名前, 件目, ...] の形で場所が分かるときは「<名前>」の <n> 件目 を先頭に置く（人が直す場所を日本語で示す）
const decodeReason = (error: Schema.SchemaError): string =>
  oneLine(
    formatIssues(error.issue)
      .issues.map(({ message, path }) => {
        const keys = (path ?? []).map((segment) => (Predicate.isObject(segment) ? segment.key : segment));
        const [kind, index, ...rest] = keys;
        const item = Predicate.isString(kind) && Predicate.isNumber(index) ? `「${kind}」の ${index + 1} 件目` : undefined;
        const where = (item === undefined ? keys : rest).map(String).join(".");
        const at = [item, where === "" ? undefined : where].filter((part) => part !== undefined).join(" ");
        return at === "" ? message : `${at}: ${message}`;
      })
      .join(" / "),
  );

/* ----------------------------------------------------------------------------
 * 境界: 設定・標準出力・ファイル読み込み
 * -------------------------------------------------------------------------- */

// 標準出力。Console.log が末尾に改行を足すので、改行の規則（withoutFinalNewline）で末尾の 1 つを外して渡す
const write = (text: string) => Console.log(withoutFinalNewline(text));

// ファイル操作の失敗（PlatformError）を入口の 1 行にする。理由は OS のエラー（ENOENT など）の文面
const fileFailed = (e: PlatformError.PlatformError) => new CommandFailed({ message: fileReason(e) });
const orFileFailed = <A, E, R>(effect: Effect.Effect<A, E | PlatformError.PlatformError, R>) =>
  effect.pipe(Effect.catchIf(PlatformError.isPlatformError, (e) => Effect.fail(fileFailed(e))));

// 待ち受けの失敗（ServeError は message を持たないので cause から作る）を入口の 1 行にする
const listenFailed = (port: number, e: { readonly cause: unknown }) =>
  new CommandFailed({
    message: Predicate.hasProperty(e.cause, "code") && e.cause.code === "EADDRINUSE"
      ? `ポート ${port} は別のプロセスが使っています（LIVE_MINDMAP_PORT で変えられます）`
      : `ポート ${port} で待ち受けられません: ${describe(e.cause)}`,
  });

// パスの存在判定。親が通常ファイル（ENOTDIR）のときは「存在しない」。それ以外の失敗は PlatformError のまま返す
const pathExists = (fs: FileSystem.FileSystem, path: string) =>
  fs.exists(path).pipe(
    Effect.catchIf(
      (e) => PlatformError.isPlatformError(e) && Predicate.hasProperty(e.cause, "code") && e.cause.code === "ENOTDIR",
      () => Effect.succeed(false),
    ),
  );

// セッションのフォルダ（名前は開始時刻）のうち、file を持つ最新のもの
const latestSession = Effect.fn("latestSession")(function* (sessionsDir: string, file: string) {
  const fs = yield* FileSystem.FileSystem;
  const latest = (yield* pathExists(fs, sessionsDir))
    ? (yield* Effect.filter(yield* fs.readDirectory(sessionsDir), (d) => pathExists(fs, join(sessionsDir, d, file)))).sort().at(-1)
    : undefined;
  return latest === undefined ? yield* new NoSession({ sessionsDir }) : latest;
}, orFileFailed);

/* ----------------------------------------------------------------------------
 * 常駐サーバーへの依頼（HTTP の境界）
 * -------------------------------------------------------------------------- */

const ServerErrorBody = Schema.Struct({ error: Schema.optionalKey(Schema.String) });
// 開始前の確かめで断られた応答の本文（http.ts の respond が書く）
const StartupRefusal = Schema.TaggedStruct("StartupDepsMissing", { items: StartupDepsMissing.fields.items });
// 要求に添えるもの。本文は、記述が本文の Schema を持つ経路でだけ必須で、その Encoded 型で書く（欄を書き間違えると型エラー）
type ServerRequestOptions<R extends ServerRoute> =
  & (R extends { readonly body: infer B extends Schema.Top } ? { readonly body: B["Encoded"] } : { readonly body?: never })
  & { readonly query?: Record<string, string> };

// 本文を持つ経路では options を省けない（本文の型保証を、引数の省略で迂回させない）
type ServerRequestArgs<R extends ServerRoute> = R extends { readonly body: Schema.Top } ? [options: ServerRequestOptions<R>] : [options?: ServerRequestOptions<R>];

const executeServerRequest = Effect.fnUntraced(function* <R extends ServerRoute>(
  port: number,
  route: R,
  ...[options]: ServerRequestArgs<NoInfer<R>>
) {
  const client = yield* HttpClient.HttpClient;
  const query = options?.query === undefined ? "" : `?${new URLSearchParams(options.query).toString()}`;
  const base = HttpClientRequest.make(route.method)(`http://127.0.0.1:${port}${route.path}${query}`);
  const request = options?.body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, options.body);
  const response = yield* client.execute(request).pipe(Effect.mapError(() => new ServerUnreachable()));
  if (response.status < 200 || response.status >= 300) {
    // 応答の本文が JSON でなくても、状態コードから作る 1 行で伝えられるようにする
    const raw = yield* response.json.pipe(Effect.orElseSucceed((): unknown => ({})));
    const refusal = Schema.decodeUnknownResult(StartupRefusal)(raw);
    if (Result.isSuccess(refusal)) return yield* new StartupDepsMissing({ items: refusal.success.items });
    const reported = yield* Schema.decodeUnknownEffect(ServerErrorBody)(raw).pipe(
      Effect.orElseSucceed((): { readonly error?: string } => ({})),
    );
    return yield* new ServerFailed({ message: reported.error ?? `サーバーがエラーを返しました: ${response.status}` });
  }
  return response;
});

// 成功応答の本文を各コマンドの Schema で読む
const decodeServerBody = Effect.fnUntraced(function* <S extends Schema.Decoder<unknown>>(response: HttpClientResponse.HttpClientResponse, schema: S): Effect.fn.Return<S["Type"], ServerFailed, S["DecodingServices"]> {
  // 2xx でも、本文が JSON として読めなければ {} として各コマンドの Schema で読む。JSON の null は null のまま
  const parsed = yield* response.text.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
    Effect.orElseSucceed((): unknown => ({})),
  );
  return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
    Effect.mapError((e) => new ServerFailed({ message: `サーバーの応答が読めません: ${decodeReason(e)}` })),
  );
});

// 常駐サーバーへ経路の記述で依頼を送り、成功応答を記述の response の Schema で読む
const requestServer = <R extends ServerRoute & { readonly response: Schema.Decoder<unknown> }>(
  port: number,
  route: R,
  ...args: ServerRequestArgs<NoInfer<R>>
): Effect.Effect<R["response"]["Type"], ServerUnreachable | ServerFailed | StartupDepsMissing, HttpClient.HttpClient> =>
  executeServerRequest(port, route, ...args).pipe(Effect.flatMap((response) => decodeServerBody(response, route.response)));

/* ----------------------------------------------------------------------------
 * サブコマンド
 * -------------------------------------------------------------------------- */

// セッションのフォルダ（log.jsonl を持つフォルダ）のログから、再生に渡す題名・発言を読む。
// 流すのは start（題名）・remark だけで、ほかの行（intake-*・diff など）は読み飛ばす
const loadSessionLog = Effect.fn("loadSessionLog")(function* (dir: string) {
  const logPath = join(dir, LOG_FILE);
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* pathExists(fs, logPath).pipe(orFileFailed))) return yield* new CommandFailed({ message: `${LOG_FILE} がありません: ${logPath}` });
  const { lines, events } = yield* readLogLines(logPath).pipe(orFileFailed);
  let title: string | undefined;
  const remarks: PlaybackRemark[] = [];
  for (const [i, event] of events.entries()) {
    if (!isReplayedEvent(event)) continue;
    const decoded = yield* Schema.decodeUnknownEffect(LogEvent)(event).pipe(
      Effect.mapError((e) => new BrokenLogLine({ line: lines[i]?.no ?? 1, reason: decodeReason(e) })),
    );
    if (decoded.type === "start") title ??= decoded.title;
    else if (decoded.type === "remark") remarks.push(decoded.remark);
  }
  if (title === undefined) return yield* new CommandFailed({ message: `${LOG_FILE} に start の行がありません: ${logPath}` });
  return { title, remarks };
});

const readTranscriptRemarks = Effect.fn("readTranscriptRemarks")(function* (transcript: string) {
  const text = yield* readTextFile(transcript).pipe(Effect.mapError((e) => new InvalidTranscriptFile({ path: transcript, reason: fileReason(e) })));
  const file = yield* Schema.decodeEffect(Schema.fromJsonString(TranscriptFile))(text).pipe(
    Effect.mapError((e) => new InvalidTranscriptFile({ path: transcript, reason: decodeReason(e) })),
  );
  return [...fromTranscript(file)];
});

// 無いパスは false（ファイルを渡す play の入口でも失敗にしない）
const isDirectory = Effect.fn("isDirectory")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.exists(path)) && (yield* fs.stat(path)).type === "Directory";
}, orFileFailed);

// 差分更新のモデル（Claude のモデルの id）。省略すると組み込みの既定
const modelFlag = Flag.String("model").pipe(Flag.withDescription("差分更新に使う Claude のモデルの id（例 claude-haiku-5-5。省略すると claude-sonnet-5-5）"), Flag.optional);
const resolveModel = (model: Option.Option<string>): ExecutableModel => claudeModel(Option.getOrUndefined(model));

const recordPlayback = Effect.fn("recordPlayback")(function* (
  input: { title: string; remarks: Iterable<PlaybackRemark>; realtime: boolean },
  model: ExecutableModel,
  publish: (snapshot: Snapshot) => Effect.Effect<void>,
  diffUpdate?: (frame: DiffUpdateFrame) => Effect.Effect<void>,
) {
  const sessionsDir = yield* sessionsDirConfig;
  const dir = yield* createSessionDir(sessionsDir).pipe(Effect.mapError((e) => new CommandFailed({ message: describe(e) })));
  const { session, appendLog } = yield* openLoggedSession({ dir, title: input.title, publish, model, ...(diffUpdate ? { diffUpdate } : {}) });
  // 待って流すときだけ、再生の開始（音声の時刻 0）の壁時計を残す。待たない流し直しには残さないので、遅れの集計は計測なしになる
  if (input.realtime) yield* appendLog({ type: "origin", wallTime: DateTime.nowUnsafe().epochMilliseconds });
  yield* playback(session, input.remarks, input.realtime ? { sleep: (ms: number) => Effect.sleep(ms) } : {});
  const paths = yield* writeSessionExports(dir, yield* session.snapshot, describe, new Map()).pipe(
    Effect.mapError((e) => new CommandFailed({ message: e.message })),
  );
  return { dir, paths };
});

const play = Command.make(
  "play",
  {
    model: modelFlag,
    transcript: Argument.String("source").pipe(
      Argument.withDescription(
        "再生する文字起こしファイル（kanary transcribe の JSON）、または過去のセッションのフォルダ（log.jsonl を持つフォルダ）。"
          + "フォルダのときは、ログの発言を元の時刻のまま流す。題名は元の start の行から取る",
      ),
    ),
    realtime: Flag.Boolean("realtime").pipe(
      Flag.withDescription("発言の時刻どおりに等速で再生する（既定は待ち時間なし）"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("play")(
    function* ({ realtime, transcript, model }) {
      const selected = resolveModel(model);
      const updaterLayer = yield* prepareUpdaterLayer(selected);
      return yield* Effect.gen(function* () {
        const port = yield* portConfig;
        const folder = yield* isDirectory(transcript);
        // セッションのフォルダはログを再生の前にすべて読む。壊れていれば何も始めずに失敗する
        const recorded = folder ? yield* loadSessionLog(resolve(transcript)) : undefined;
        // 配信は play の Scope が持つ。再生と書き出しが終わって Scope を閉じるときに、待受けも閉じる
        const listener = yield* openListener(port).pipe(
          Effect.mapError((e) => listenFailed(port, e)),
        );
        // 配信の開始と、待受けを閉じる前に最後のスナップショットを接続中のクライアントへ渡し切る登録を、受け取った Context への 1 回の provide で行う
        const viewers = yield* Effect.gen(function* () {
          yield* serveFeed;
          const viewers = yield* Viewers;
          yield* Effect.addFinalizer(() => viewers.drained);
          return viewers;
        }).pipe(Effect.provide(listener));
        const remarks = recorded ? recorded.remarks : yield* readTranscriptRemarks(transcript);
        yield* viewers.sessionMode({ type: "session-mode", local: selected.local });
        const { paths } = yield* recordPlayback({
          title: recorded ? recorded.title : basename(transcript).replace(/\.transcript\.json$/, ""),
          remarks, realtime,
        }, selected, viewers.publish, viewers.diffUpdate).pipe(Effect.ensuring(viewers.sessionMode({ type: "session-mode", local: false })));
        yield* write(paths.map((path) => `${path}\n`).join(""));
      }).pipe(Effect.provide(updaterLayer));
    },
    Effect.scoped,
  ),
).pipe(
  Command.withDescription(
    "録音サンプルの文字起こし、または過去のセッションのフォルダ（log.jsonl を持つフォルダ）を再生し、マップを組み立てる（既定は待ち時間なし、--realtime で等速）。"
      + "再生中は WebSocket で、反映のたびにマップ全体をブラウザへ送る。"
      + "終わると、セッションのフォルダに map.md・map.json・map.drawnix・map.html を書き出し、そのパスを出す",
  ),
);

const apps = Command.make(
  "apps",
  {},
  Effect.fn("apps")(function* () {
    const port = yield* portConfig;
    // 一覧の中身は CLI が使わないので、形を決めずにそのまま出す
    const list = yield* requestServer(port, ServerRoutes.apps);
    yield* write(JSON.stringify(list, null, 2) + "\n");
  }),
).pipe(Command.withDescription("会議アプリの一覧（JSON）を出す。常駐サーバー（pnpm dev）に頼む"));

const titleFlag = Flag.String("title").pipe(Flag.withDescription("会議の名前（省略するとセッションの開始時刻）"), Flag.optional);

const start = Command.make(
  "start",
  {
    model: modelFlag,
    app: Flag.String("app").pipe(Flag.withDescription("会議アプリの識別子（cli apps の一覧の id）")),
    title: titleFlag,
  },
  Effect.fn("start")(function* ({ app, title, model }) {
    const port = yield* portConfig;
    const { dir } = yield* requestServer(port, ServerRoutes.sessionStart, { body: {
      app,
      title: Option.getOrUndefined(title),
      model: resolveModel(model),
    } });
    yield* write(`${dir}\n`);
  }),
).pipe(
  Command.withDescription("ライブのセッションを開始する。サーバーがヘルパーを起動し、セッションのフォルダを出す。同時に 1 つだけ"),
);

const stop = Command.make(
  "stop",
  {},
  Effect.fn("stop")(function* () {
    const port = yield* portConfig;
    const { paths } = yield* requestServer(port, ServerRoutes.sessionStop);
    yield* write(paths.map((path) => `${path}\n`).join(""));
  }),
).pipe(
  Command.withDescription("ライブのセッションを終了し、map.md・map.json・map.drawnix・map.html を書き出して、そのパスを出す"),
);

const status = Command.make(
  "status",
  {},
  Effect.fn("status")(function* () {
    const port = yield* portConfig;
    const report: IntakeStatusReport = yield* requestServer(port, ServerRoutes.sessionStatus);
    const share = yield* requestServer(port, ServerRoutes.shareStatus);
    yield* write(formatIntakeStatus(report) + formatShareStatus(share));
  }),
).pipe(
  Command.withDescription("取り込みの状態（動いている／途切れている／止まった／セッションなし）・セッションのフォルダ・起動し直した回数・最後の途切れの時刻と、閲覧の共有の状態（共有中／無し）・URL・PIN を出す"),
);

const share = Command.make(
  "share",
  {
    stop: Flag.Boolean("stop").pipe(Flag.withDescription("閲覧の共有を閉じる（共有していなくても成功する）"), Flag.withDefault(false)),
  },
  Effect.fn("share")(function* ({ stop }) {
    const port = yield* portConfig;
    if (stop) {
      yield* requestServer(port, ServerRoutes.shareClose);
      yield* write("閲覧の共有を閉じました\n");
      return;
    }
    yield* write(formatShareOpened(yield* requestServer(port, ServerRoutes.shareOpen)));
  }),
).pipe(
  Command.withDescription(
    "閲覧の共有（ADR 0003）を開き、同じ LAN の端末（Android など）のブラウザで開く URL（PIN 付き）を出す。セッション中にだけ開ける。"
      + "すでに開いていれば同じ URL を出す。--stop で閉じる。セッションの終了でも閉じる",
  ),
);

const resume = Command.make(
  "resume",
  {},
  Effect.fn("resume")(function* () {
    const port = yield* portConfig;
    yield* executeServerRequest(port, ServerRoutes.sessionResume);
  }),
).pipe(
  Command.withDescription("止まった状態（起動し直しを諦めた状態）から、ヘルパーを起動し直して同じセッションを続ける"),
);

const exportCommand = Command.make(
  "export",
  {
    format: Flag.Literals("format", ["md", "json"]).pipe(
      Flag.withDescription("出す形式（md は Markdown、json は map.json と同じ内容）"),
      Flag.withDefault("md"),
    ),
  },
  Effect.fn("export")(function* ({ format }) {
    const sessionsDir = yield* sessionsDirConfig;
    const latest = yield* latestSession(sessionsDir, EXPORT_FILE);
    const path = join(sessionsDir, latest, EXPORT_FILE);
    const text = yield* readTextFile(path).pipe(Effect.mapError(fileFailed));
    if (format === "json") {
      // json はマップの形を使わないので、保存した値をそのまま出す（宣言していないキーも落とさない）
      const raw = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
        Effect.mapError((e) => new CommandFailed({ message: `${path} が JSON として読めません: ${decodeReason(e)}` })),
      );
      yield* write(JSON.stringify(raw, null, 2) + "\n");
      return;
    }
    const exported = yield* Schema.decodeEffect(Schema.fromJsonString(JsonExport))(text).pipe(
      Effect.mapError((e) => new CommandFailed({ message: `${path} が読めません: ${decodeReason(e)}` })),
    );
    yield* write(toMarkdown(exported));
  }),
).pipe(Command.withDescription("最新のセッションのマップを標準出力に出す（既定は md。ファイルは作らない）"));

const restore = Command.make(
  "restore",
  {},
  Effect.fn("restore")(function* () {
    const sessionsDir = yield* sessionsDirConfig;
    const dir = join(sessionsDir, yield* latestSession(sessionsDir, LOG_FILE));
    const { lines, events } = yield* readLogLines(join(dir, LOG_FILE)).pipe(orFileFailed);
    // 復元では差分更新を呼ばない。呼ばれたら defect にする。ログは書き直さない
    const session = yield* restoreSession(events).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DiffUpdater)(DiffUpdater.of({ update: () => Effect.die("restore では差分更新を呼べません") })),
          Layer.succeed(SessionLog)(SessionLog.of({ write: () => Effect.void, writeScreen: () => Effect.void, readScreen: () => Effect.die("restore は共有画面を読まない") })),
        ),
      ),
      // 壊れた行は、空行を除く前の行番号の BrokenLogLine にする
      Effect.catchTag("InvalidLogEvent", (e) => Effect.fail(new BrokenLogLine({ line: lines[e.index]?.no ?? 1, reason: e.reason }))),
    );
    const exported = yield* session.exportJson;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(join(dir, EXPORT_FILE), JSON.stringify(exported)).pipe(orFileFailed);
    yield* write(`${dir}\n`);
  }, Effect.scoped),
).pipe(Command.withDescription("最新のセッションのログから、差分更新を呼ばずにマップを戻す"));

// 渡されたセッションのフォルダ（省略すると log.jsonl を持つ最新のセッション）と、その log.jsonl。log.jsonl が無ければ失敗にする
const sessionLog = Effect.fnUntraced(function* (session: Option.Option<string>) {
  const dir = Option.isSome(session)
    ? resolve(session.value)
    : yield* Effect.gen(function* () {
        const sessionsDir = yield* sessionsDirConfig;
        return resolve(sessionsDir, yield* latestSession(sessionsDir, LOG_FILE));
      });
  const logPath = join(dir, LOG_FILE);
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* pathExists(fs, logPath).pipe(orFileFailed))) return yield* new CommandFailed({ message: `${LOG_FILE} がありません: ${logPath}` });
  return { dir, logPath };
});

const latency = Command.make(
  "latency",
  {
    session: Argument.String("session").pipe(
      Argument.withDescription("遅れを集計するセッションのフォルダ（省略すると log.jsonl を持つ最新のセッション）"),
      Argument.optional,
    ),
  },
  Effect.fn("latency")(function* ({ session }) {
    const { logPath } = yield* sessionLog(session);
    const { lines, events } = yield* readLogLines(logPath).pipe(orFileFailed);
    const report = yield* latencyReport(events).pipe(
      Effect.catchTag("InvalidLogEvent", (e) => Effect.fail(new BrokenLogLine({ line: lines[e.index]?.no ?? 1, reason: e.reason }))),
    );
    yield* write(formatLatencyTable(report));
  }),
).pipe(
  Command.withDescription("セッションの log.jsonl から、区間ごと・トラックごとの遅れ（件数・中央値・p90・最大の ms）の表を出す。本文は読まない。測れない区間は計測なし。サーバーは要らない"),
);

const review = Command.make(
  "review",
  {
    session: Argument.String("session").pipe(
      Argument.withDescription("見返し用の map.html を作り直すセッションのフォルダ（省略すると log.jsonl を持つ最新のセッション）"),
      Argument.optional,
    ),
  },
  Effect.fn("review")(function* ({ session }) {
    const { dir } = yield* sessionLog(session);
    const { paths } = yield* writeReview(dir).pipe(
      Effect.mapError((e) => new CommandFailed({ message: reviewWarning(REVIEW_FILE, describe(e)) })),
    );
    yield* write(paths.map((path) => `${path}\n`).join(""));
  }),
).pipe(
  Command.withDescription("セッションの log.jsonl から、見返し用の map.html を作り直してパスを出す。サーバーは要らない"),
);

// 元ログを選んだモデルで再生し、新しいランのフォルダを返す（updater の layer などは呼び出し側の Scope が持つ）
const replayedRunDir = Effect.fnUntraced(function* (source: string, model: ExecutableModel) {
  const recorded = yield* loadSessionLog(resolve(source));
  const updaterLayer = yield* prepareUpdaterLayer(model);
  return (yield* recordPlayback({ ...recorded, realtime: false }, model, () => Effect.void).pipe(
    Effect.provide(updaterLayer),
  )).dir;
});

const evaluatedRun = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, dir: string) {
  const path = join(dir, EXPORT_FILE);
  if (!(yield* pathExists(fs, path).pipe(orFileFailed))) return yield* new MissingRunExport({ path });
  const text = yield* readTextFile(path).pipe(Effect.mapError(fileFailed));
  const exp = yield* Schema.decodeEffect(Schema.fromJsonString(JsonExport))(text).pipe(
    Effect.mapError((e) => new CommandFailed({ message: `${path} が読めません: ${decodeReason(e)}` })),
  );
  const logPath = join(dir, LOG_FILE);
  if (!(yield* pathExists(fs, logPath).pipe(orFileFailed))) return { name: basename(dir), title: exp.root.text, exp };
  // 検証は restore と同じ restoreState で行う。壊れた行は、どのランか分かるようにパスと行番号を添えて失敗にする
  const { lines, events } = yield* readLogLines(logPath).pipe(
    orFileFailed,
    Effect.catchTag("BrokenLogLine", (e) => Effect.fail(new CommandFailed({ message: `${logPath} の ${e.line} 行目が JSON として読めません: ${e.reason}` }))),
  );
  yield* restoreState(events).pipe(
    Effect.catchTag("InvalidLogEvent", (e) => Effect.fail(new CommandFailed({ message: `${logPath} の ${lines[e.index]?.no ?? 1} 行目が読めません: ${e.reason}` }))),
  );
  const log = yield* Effect.forEach(events.filter(isEvalEvent), (event) => Schema.decodeUnknownEffect(LogEvent)(event).pipe(Effect.orDie));
  return { name: basename(dir), title: exp.root.text, exp, log };
});

const evaluate = Command.make(
  "eval",
  {
    model: modelFlag,
    truth: Flag.File("truth").pipe(
      Flag.withDescription("正解ファイル（JSON）。形は core/evaluate.ts の Truth が正本"),
      Flag.optional,
    ),
    screenTruth: Flag.File("screen-truth").pipe(
      Flag.withDescription("共有画面の正解ファイル（JSON）。形は core/evaluate.ts の ScreenTruth が正本"),
      Flag.optional,
    ),
    sessions: Argument.String("session").pipe(
      Argument.withDescription("play で作ったセッションのフォルダ"),
      Argument.atLeast(1),
    ),
  },
  Effect.fn("eval")(function* ({ sessions, truth, screenTruth, model }) {
    // 正解ファイルの検証は共有の readTruthFile（段 1 の Truth の Schema）が持つ（Flag 側では検証しない）
    const expected = Option.isNone(truth) ? undefined : yield* readTruthFile(truth.value);
    const screen = Option.isNone(screenTruth) ? undefined : yield* readScreenTruthFile(screenTruth.value);
    const fs = yield* FileSystem.FileSystem;
    const runs: Run[] = [];
    for (const source of sessions) {
      const dir = Option.isNone(model) ? source : yield* replayedRunDir(source, resolveModel(model)).pipe(Effect.scoped);
      runs.push(yield* evaluatedRun(fs, dir));
    }
    const table = yield* formatTable(runs, expected, screen).pipe(
      Effect.catchTag("InvalidLogEvent", (e) => Effect.fail(new CommandFailed({ message: `log.jsonl の指標が数えられません: ${e.reason}` }))),
    );
    yield* write(table);
  }),
).pipe(
  Command.withDescription(
    "play で作ったランの指標を 1 ラン 1 行の表で出す。log.jsonl があれば、本文の書き換えの回数÷発言の数・1 ノードの書き換えの最多・話し中の兄弟の最多も出す（無ければ -）。--truth を渡すと決定・TODO の再現率と種別違い（正解が別の種別のノードとして出た数）も、--screen-truth を渡すと指す発言・うち記憶・話だけ・出てはいけないの列も出す"
      + "（当たる条件と 1 対 1 の数え方は core/evaluate.ts の matches・recall が持つ）。"
      + "--model を明示したときだけ元ログを選んだモデルで再生し、新しいランを評価する。指定なしでは保存済み結果を集計する",
  ),
);

const checkCommand = Command.make(
  "check",
  {},
  Effect.fn("check")(function* () {
    const report = yield* requestServer(yield* portConfig, ServerRoutes.check);
    yield* write(JSON.stringify(report));
    if (report.items.some(isMissing)) return yield* new RequiredDepsMissing();
  }),
).pipe(Command.withDescription(
  "開始せず、開始前の確かめ（ヘルパー・マイクの許可・音声認識のモデル）を JSON で出す。足りないものがあれば exit code 3。常駐サーバー（pnpm dev）に頼む",
));

// サーバーに終了を求めた後、終わるのを待つ上限と、確かめる間隔
const SERVER_EXIT_TIMEOUT_MS = 15_000;
const SERVER_EXIT_POLL_MS = 100;

const serverStop = Command.make(
  "stop",
  {},
  Effect.fn("server stop")(function* () {
    const port = yield* portConfig;
    const sessionsDir = yield* sessionsDirConfig;
    const processes = yield* ServerProcess;
    const recorded = yield* orFileFailed(readServerPid(sessionsDir, port)).pipe(
      Effect.catchTag("BrokenServerPid", (e) => Effect.fail(new CommandFailed({ message: e.message }))),
    );
    const reported = yield* requestServer(port, ServerRoutes.server).pipe(
      Effect.map((identity): number | undefined => identity.pid),
      Effect.catchTags({
        ServerUnreachable: () => Effect.succeed<number | undefined>(undefined),
        // PID を名乗る口が無いのは、この口より前の版のサーバー
        ServerFailed: () => Effect.fail(new CommandFailed({ message: `ポート ${port} のサーバーは server stop に対応していない版です。起動した端末で Ctrl-C で止めてください` })),
      }),
    );
    const plan = planServerStop({ reported, recorded, recordedAlive: recorded === undefined ? false : yield* processes.alive(recorded) });
    switch (plan.action) {
      case "not-running":
        if (plan.stale !== undefined) yield* orFileFailed(removeServerPid(sessionsDir, port));
        yield* write(`ポート ${port} のサーバーは動いていません\n`);
        return;
      case "unresponsive":
        return yield* new CommandFailed({
          message: `ポート ${port} のサーバーが応答しません。記録の pid ${plan.pid} が live-mindmap のサーバーか確かめてから止めてください`,
        });
      case "terminate": {
        // 止めるとセッションは書き出されずに終わるので、進行中なら断る
        const { status } = yield* requestServer(port, ServerRoutes.sessionStatus);
        if (status !== "none") return yield* new CommandFailed({ message: "セッションが進行中です。先に cli stop で書き出してから、もう一度 server stop を打ってください" });
        // シグナルではなく HTTP で終了を求める（Windows にはシグナルが無い）。サーバーは 204 を返してから後片付けして終わる
        yield* executeServerRequest(port, ServerRoutes.serverStop);
        const exited = yield* processes.alive(plan.pid).pipe(
          Effect.repeat({ until: (alive) => !alive, schedule: Schedule.spaced(SERVER_EXIT_POLL_MS) }),
          Effect.timeoutOption(SERVER_EXIT_TIMEOUT_MS),
        );
        if (Option.isNone(exited)) return yield* new CommandFailed({ message: `サーバー（pid ${plan.pid}）が ${SERVER_EXIT_TIMEOUT_MS / 1000} 秒たっても終わりません` });
        yield* write(`サーバーを止めました（ポート ${port}、pid ${plan.pid}）\n`);
      }
    }
  }),
).pipe(Command.withDescription(
  "常駐サーバー（pnpm dev）を止める。LIVE_MINDMAP_PORT のポートで応答したサーバー自身に終了を求め（/server/stop）、名乗った PID が終わるまで待つ。"
    + "セッションが進行中なら断る（先に stop）。動いていなければ何もしない。taskkill などで止めない",
));

const serverCommand = Command.make("server").pipe(
  Command.withDescription("常駐サーバー（pnpm dev）そのものの操作。止めるのは server stop"),
  Command.withSubcommands([serverStop]),
);

const root = Command.make("live-mindmap").pipe(
  Command.withDescription(
    "会議の文字起こし・ライブのセッションから、議論のマインドマップを組み立てる（上流 ADR 0003）。"
      + "exit code 3 = 開始に要るもの（ヘルパー・マイクの許可・音声認識のモデル）が足りない",
  ),
  Command.withSubcommands([play, apps, start, stop, status, resume, share, exportCommand, restore, review, latency, evaluate, checkCommand, serverCommand]),
);

// argv を受けて走らせるだけ。失敗の表示はしない（入口の reportFailure が 1 か所で持つ）
export const runCli = Command.runWith(root, { version: VERSION });

/* ----------------------------------------------------------------------------
 * 入口
 * -------------------------------------------------------------------------- */

// 失敗の表示はここだけ。共通の前半（entryFailure）で済まないものを、この表で表示する
export const reportFailure = reportEntryFailure((failure) => {
  if (failure instanceof RequiredDepsMissing) return Effect.void;
  return Console.error(isCliFailure(failure) ? (failure._tag === "UpdaterUnavailable" || failure._tag === "ServerFailed" ? failureLine(failure) : oneLine(failureLine(failure))) : describe(failure));
});

export const teardown: Runtime.Teardown = exitCodeTeardown((failure) => (failure instanceof RequiredDepsMissing || failure instanceof StartupDepsMissing ? 3 : undefined));

if (import.meta.main) {
  runCli(process.argv.slice(2)).pipe(
    Effect.tapCause(reportFailure),
    Effect.provide(Layer.mergeAll(NodeServices.layer, ReviewBuild.layer.pipe(Layer.provide(NodeServices.layer)), NodeHttpClient.layerUndici)),
    NodeRuntime.runMain({ disableErrorReporting: true, teardown }),
  );
}
