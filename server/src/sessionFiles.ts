// セッションのフォルダに対するファイル操作（作成・ログと export.json の追記・終了時の書き出し）。FileSystem 経由。
// play（cli.ts）とライブのセッション（sessionSinks.ts）が共有する。HTTP には依存しない
import { basename, join } from "node:path";
import { Cause, Console, DateTime, Effect, FileSystem, Layer, Ref, Schema, Semaphore } from "effect";
import { writeReviewPages } from "./review.ts";
import {
  exportFiles,
  logTimestamp,
  makeSession,
  SessionLog,
  toJsonExport,
  type IntakeLogEvent,
  type SelfPauseLogEvent,
  type SpeakerNameLogEvent,
  type DiffUpdateFrame,
  type LogEvent,
  type OnSpeakerNames,
  type Session,
  type Snapshot,
} from "./core/index.ts";
import type { ExecutableModel } from "./modelSelection.ts";

// セッションのフォルダに置く、その時点のエクスポート。別のプロセスの export がこれを読む。
// play もライブのセッションも、作成直後と log のたびに書く。サーバーが動いていなくても export できる。
export const EXPORT_FILE = "export.json";
export const LOG_FILE = "log.jsonl";
export const SCREENS_DIR = "screens"; // 共有画面の画像（JPEG）を置く、セッションのフォルダの下のフォルダ（初版では書かない。復元が読む口だけ残す）
export const REVIEW_FILE = "map.html";

// テキストの 3 形式（map.md・map.json・map.drawnix）を書き、書いたパスを順に返す
export const writeExportFiles = Effect.fnUntraced(function* (dir: string, snapshot: Snapshot, names: ReadonlyMap<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  const paths: string[] = [];
  for (const [name, content] of Object.entries(exportFiles(toJsonExport(snapshot, snapshot.remarks, names)))) {
    const path = join(dir, name);
    yield* fs.writeFileString(path, content.endsWith("\n") ? content : content + "\n");
    paths.push(path);
  }
  return paths;
});

export const reviewWarning = (file: string, reason: string) => `${file} を書き出せませんでした: ${reason}`;

// テキストの 3 形式（map.md・map.json・map.drawnix）を書けなかった。message は書き込みの失敗の理由。
// cli は CommandFailed に、サーバーは defect にする（HTML と違って、これだけは諦めずに失敗にする）
export class ExportFilesFailed extends Schema.TaggedError<ExportFilesFailed>()("ExportFilesFailed", { message: Schema.String }) {}

// 見返し用の HTML（map.html）を書く
export const writeReview = (dir: string) => writeReviewPages(dir, join(dir, LOG_FILE), [{ file: REVIEW_FILE }]);

// セッション終了時の書き出し。スナップショットは 1 回だけ取り、4 形式（md・json・drawnix・html）を書く。
// play（cli.ts）とライブのセッションの終了処理（sessionSinks.ts）が、この関数を呼ぶ。書いたファイルのパスを順に返す。
// HTML のビルドと FileSystem は文脈から受け取る。テキストの 3 形式を先に書く。HTML の書き出しが失敗したとき
// （型付きの失敗も、中断以外の defect も）はそれだけ諦めて、標準エラー（Console）に理由を残し、書けたもののパスを返す。
// 中断は警告にせず伝える。理由の整形（formatReason）は入口が決める（cli は 1 行にし、サーバーは元の理由のまま）
export const writeSessionExports = Effect.fnUntraced(function* (dir: string, snapshot: Snapshot, formatReason: (e: unknown) => string, names: ReadonlyMap<string, string>) {
  const paths = yield* writeExportFiles(dir, snapshot, names).pipe(Effect.mapError((e) => new ExportFilesFailed({ message: formatReason(e) })));
  const reviewed = yield* Effect.catchCauseIf(
    writeReview(dir),
    (cause) => !Cause.hasInterrupts(cause),
    (cause) => Effect.as(Console.error(reviewWarning(REVIEW_FILE, formatReason(Cause.squash(cause)))), undefined),
  );
  if (reviewed) paths.push(...reviewed.paths);
  return paths;
});

// セッションのフォルダ（名前は基準の時刻。省略すると開始時刻）を作る。
// 同じ名前のフォルダが既にあれば使い回さず、-2、-3… を付けた新しいフォルダを作る
export const createSessionDir = Effect.fnUntraced(function* (sessionsDir: string, at?: DateTime.DateTime) {
  const fs = yield* FileSystem.FileSystem;
  const base = join(sessionsDir, DateTime.formatIso(at ?? DateTime.nowUnsafe()).replaceAll(":", "-"));
  yield* fs.makeDirectory(sessionsDir, { recursive: true });
  for (let n = 1; ; n++) {
    const dir = n === 1 ? base : `${base}-${n}`;
    const created = yield* fs.makeDirectory(dir).pipe(
      Effect.as(true),
      Effect.catchIf((e) => e.reason._tag === "AlreadyExists", () => Effect.succeed(false)),
    );
    if (created) return dir;
  }
});

export type LoggedSessionOptions = {
  model: ExecutableModel;
  dir: string; // createSessionDir で作ったセッションのフォルダ
  title?: string; // 省略したときは、セッションのフォルダ名（開始時刻）
  publish: (snapshot: Snapshot) => Effect.Effect<void>;
  onDiff?: Effect.Effect<void>; // 差分更新の 1 回が終わった（成功の publish の後・失敗のとき）。未反映の発言が変わったことを知らせる
  diffUpdate?: (frame: DiffUpdateFrame) => Effect.Effect<void>;
  onPendingChange?: Effect.Effect<void>; // 順番待ち・呼び出し中・取り込めなかった発言が変わった。取り込み待ちのフレームを組み直す合図
  onSpeakerNames?: OnSpeakerNames; // 差分更新の応答の名前のうち、根拠の確かめを通ったもの（diff の行を書いた後）。cli play は渡さない
};

// 作成済みのセッションのフォルダに、ログと export.json を書きながら、マップが変わるたびに publish する。
// play もライブのセッションも、この 1 つの配線で動かす（出どころだけが違う）。差分更新（DiffUpdater）は呼び出し側が提供する。
// appendLog は、サーバーが取り込みの途切れ等（LogEvent ではない独自の種類）を log.jsonl へ追記するための口。
// session のログと同じ書き先・同じ at 付きの形を共有するが、export.json は書き直さない（マップを変えない記録のため）。
// ログが書けないとき（FileSystem の失敗）は、そのまま defect にする。
export const openLoggedSession = Effect.fnUntraced(function* ({ dir, title, publish, onDiff, diffUpdate, onSpeakerNames, onPendingChange, model }: LoggedSessionOptions) {
  // SessionLog のメソッドの R は空なので、FileSystem はここで 1 回だけ受け取ってクロージャで使う
  const fs = yield* FileSystem.FileSystem;
  // 書き先（log.jsonl）と at 付きの形は、session のログ（LogEvent）とサーバーの独自の記録（IntakeLogEvent）で共有する。
  // at は Clock ではなく実時刻（TestClock の下でも log.jsonl は実際の時刻で書く）。Effect を実行した時点で決める
  const writeLogLine = (event: LogEvent | IntakeLogEvent | SelfPauseLogEvent | SpeakerNameLogEvent) =>
    Effect.suspend(() =>
      fs.writeFileString(join(dir, LOG_FILE), JSON.stringify({ at: logTimestamp(), ...event }) + "\n", { flag: "a" }),
    ).pipe(Effect.orDie);
  const writeExport = (session: Session) =>
    Effect.flatMap(session.exportJson, (json) => fs.writeFileString(join(dir, EXPORT_FILE), JSON.stringify(json))).pipe(Effect.orDie);
  // 同期の書き込みでは自然に成り立っていた性質（行が呼んだ順に並ぶ・最後の export.json が最新）を保つため、
  // ログの 1 行と export.json の書き直しは 1 つずつ、中断させずに行う。publish と onDiff は待ちに巻き込まないよう、外で呼ぶ
  const lock = yield* Semaphore.make(1);
  const serialized = <A>(effect: Effect.Effect<A>) => lock.withPermit(Effect.uninterruptible(effect));
  // 開始のイベントは makeSession の中で書かれるので、makeSession が返す前は export.json を書けない（publish もしない）
  const current = yield* Ref.make<Session | undefined>(undefined);
  const log = Layer.succeed(SessionLog)(
    SessionLog.of({
      write: (event) =>
        Effect.gen(function* () {
          const session = yield* serialized(
            Effect.gen(function* () {
              yield* writeLogLine(event.type === "start" ? { ...event, model: { name: model.name, route: model.route, local: model.local } } : event);
              const session = yield* Ref.get(current);
              if (session) yield* writeExport(session);
              return session;
            }),
          );
          if (!session) return;
          if (diffUpdate && (event.type === "diff" || event.type === "diff-update-paused" || event.type === "diff-update-state")) {
            yield* diffUpdate({ type: "diff-update", state: yield* session.diffUpdate });
          }
          if (event.type !== "diff") return;
          if (!event.error) yield* Effect.flatMap(session.snapshot, publish);
          if (onDiff) yield* onDiff;
        }),
      // 共有画面は初版では取り込まない。復元が読む口だけ残す
      writeScreen: (file, bytes) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(join(dir, SCREENS_DIR), { recursive: true });
          yield* fs.writeFile(join(dir, SCREENS_DIR, file), bytes);
        }).pipe(Effect.orDie),
      readScreen: (file) => fs.readFile(join(dir, SCREENS_DIR, file)).pipe(Effect.orDie),
    }),
  );
  if (diffUpdate) yield* Effect.addFinalizer(() => diffUpdate({ type: "diff-update", state: null }));
  const session = yield* makeSession({ title: title ?? basename(dir), ...(onSpeakerNames ? { onSpeakerNames } : {}), ...(onPendingChange ? { onPendingChange } : {}) }).pipe(Effect.provide(log));
  yield* Ref.set(current, session);
  if (diffUpdate) {
    yield* diffUpdate({ type: "diff-update", state: yield* session.diffUpdate });
  }
  // 発言が 1 件も来なくても、export が前のセッションではなくこのセッションのマップを返すように、作成直後にも書く
  yield* serialized(writeExport(session));
  yield* Effect.flatMap(session.snapshot, publish); // 最初のルート
  return { session, appendLog: (event: LogEvent | IntakeLogEvent | SelfPauseLogEvent | SpeakerNameLogEvent) => serialized(writeLogLine(event)) };
});
