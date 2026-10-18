// 見返し用の HTML（map.html）の書き出し。書き出しの時点で web を Vite の single-file ビルドにかけ、
// ログを差し込む（ビルド済みのテンプレートは持たない）。ビルドは Service にして、テストで差し替える。
// 同じビルドは、閲覧の口（Android など別の端末のブラウザ）に出す画面にも使う。
import { join } from "node:path";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { embedReviewLicenses, embedReviewLog, mapOnlyReviewEvents } from "./core/index.ts";
import { readLogLines } from "./logLines.ts";

const WEB_ROOT = join(import.meta.dirname, "../../web");
// 見返しの操作の行が写した video.js のアイコンの出どころとライセンス（Apache-2.0）。Vite の build.license はパッケージ単位で、写したファイルは載らないので、ここで足す
const ICONS_NOTICE_PATH = join(WEB_ROOT, "src/app/review/icons.NOTICE.md");

// 見返し用の HTML の書き出しの失敗。呼び出し側（CLI・server）は message をそのまま「map.html を書き出せませんでした: …」の理由に使う
export class ReviewPageFailed extends Schema.TaggedError<ReviewPageFailed>()("ReviewPageFailed", { message: Schema.String }) {}

const failed = (e: unknown) => new ReviewPageFailed({ message: e instanceof Error ? e.message : String(e) });

// 書き出す版。mapOnly が true なら、発言の文字を抜いた出来事を埋め込む
export type ReviewVariant = { readonly file: string; readonly mapOnly?: true };

// 書き出した結果。paths は書けた版のパス（版の順）
export type ReviewPagesResult = { readonly paths: string[] };

// web を single-file の HTML 1 つにビルドして、その文字列を返す。出力は一時フォルダに書き、Scope を閉じると必ず消える。
// Why: Vite の build は中断できず、中断されたファイバーは完了を待たない。中断可能のままだと、ビルドが使っている outDir を先に消してしまうため、
// 一時フォルダを使う処理（ビルドと読み取り）が終わるまで中断を遅らせる
const buildReviewTemplate = Effect.fnUntraced(function* (fs: FileSystem.FileSystem) {
  const out = yield* fs.makeTempDirectoryScoped({ prefix: "live-mindmap-review-" }).pipe(Effect.mapError(failed));
  yield* Effect.tryPromise({
    try: () =>
      build({
        root: WEB_ROOT,
        configFile: join(WEB_ROOT, "vite.config.ts"),
        logLevel: "silent",
        // Why: インライン化した chunk を bundle から消すと、build.license が同梱モジュールを集められない。出力は一時フォルダで、index.html だけ読む
        plugins: [viteSingleFile({ deleteInlinedFiles: false })],
        build: { outDir: out, emptyOutDir: true, license: true },
      }),
    catch: failed,
  });
  const html = yield* fs.readFileString(join(out, "index.html")).pipe(Effect.mapError(failed));
  const bundledLicenses = yield* fs.readFileString(join(out, ".vite/license.md")).pipe(Effect.mapError(failed));
  const iconsNotice = yield* fs.readFileString(ICONS_NOTICE_PATH).pipe(Effect.mapError(failed));
  return yield* Effect.try({ try: () => embedReviewLicenses(html, `${bundledLicenses.trimEnd()}\n\n${iconsNotice.trim()}\n`), catch: failed });
}, Effect.scoped, Effect.uninterruptible);

// 見返し用の HTML のテンプレート（ログを差し込む前）をビルドする
export class ReviewBuild extends Context.Service<ReviewBuild, {
  readonly build: Effect.Effect<string, ReviewPageFailed>;
}>()("live-mindmap/server/ReviewBuild") {
  static readonly layer: Layer.Layer<ReviewBuild, never, FileSystem.FileSystem> = Layer.effect(ReviewBuild)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return ReviewBuild.of({ build: buildReviewTemplate(fs) });
    }),
  );
}

// log.jsonl の出来事を、版ごとに 1 つの HTML へ埋め込んで返す（何も書かない）。ビルドは 1 回だけ。
// ログが読めない・ビルドに失敗したら、ReviewPageFailed で終わる。
// マップだけの版の埋め込みは mapOnlyReviewEvents（壊れた発言の行では ReviewPageFailed）
export const renderReviewPages = Effect.fnUntraced(function* (logPath: string, variants: readonly ReviewVariant[]) {
  const { events } = yield* readLogLines(logPath).pipe(
    Effect.mapError((e) =>
      e._tag === "BrokenLogLine"
        ? new ReviewPageFailed({ message: `${logPath} の ${e.line} 行目が JSON として読めません: ${e.reason}` })
        : failed(e),
    ),
  );
  const { build } = yield* ReviewBuild;
  const template = yield* build;
  const pages: { file: string; html: string }[] = [];
  for (const variant of variants) {
    const html = yield* Effect.try({ try: () => embedReviewLog(template, variant.mapOnly ? mapOnlyReviewEvents(events) : events), catch: failed });
    pages.push({ file: variant.file, html });
  }
  return { pages };
});

// renderReviewPages の結果を dir に書き、書いたパスを版の順に返す。全部作ってから書く（途中で失敗したら何も書かない）
export const writeReviewPages = Effect.fnUntraced(function* (dir: string, logPath: string, variants: readonly ReviewVariant[]) {
  const fs = yield* FileSystem.FileSystem;
  const { pages } = yield* renderReviewPages(logPath, variants);
  const written = pages.map((page) => ({ path: join(dir, page.file), html: page.html }));
  for (const page of written) yield* fs.writeFileString(page.path, page.html).pipe(Effect.mapError(failed));
  return { paths: written.map((page) => page.path) } satisfies ReviewPagesResult;
});
