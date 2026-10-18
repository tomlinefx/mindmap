import { NodeFileSystem } from "@effect/platform-node";
import { Console, Effect, FileSystem, Layer } from "effect";
import { ReviewBuild, ReviewPageFailed } from "../../src/review.ts";

// 見返し用の HTML は、書き出し（ログの読み込み・埋め込み・書き込み）は本物で、Vite のビルドだけ偽物にする
export const FAKE_TEMPLATE = "<!doctype html><html><body></body></html>";

// 終了時の書き出しが文脈から受け取る Service（ReviewBuild・FileSystem）の偽物の Layer
export type ExportServicesOptions = {
  build?: Effect.Effect<string, ReviewPageFailed>;
  fileSystem?: Layer.Layer<FileSystem.FileSystem>; // 省略時は実物（NodeFileSystem）
};

export const fakeExportServices = ({ build, fileSystem = NodeFileSystem.layer }: ExportServicesOptions = {}) =>
  Layer.succeed(ReviewBuild, ReviewBuild.of({ build: build ?? Effect.succeed(FAKE_TEMPLATE) })).pipe(Layer.provideMerge(fileSystem));

// 失敗の文面は、警告の「…を書き出せませんでした: <理由>」にそのまま出る
export const failingBuild = (message = "ビルドに失敗") => Effect.fail(new ReviewPageFailed({ message }));

// Console.error に出た行をためる Console（警告の観測）。Layer ではなく Service の値で返し、Effect.provideService(Console.Console, …) で渡す
export const collectingConsole = () => {
  const errors: string[] = [];
  const service: Console.Console = { ...console, error: (...args: unknown[]) => { errors.push(args.map(String).join(" ")); } };
  return { errors, service };
};
