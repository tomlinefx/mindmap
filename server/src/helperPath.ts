// ヘルパーの実行ファイルの場所。会議で使うので、最適化ありのビルド（Release）を既定にする（上流 issue #233 と同じ理由）
import { existsSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_HELPER_PATH = join(import.meta.dirname, "../../helper/bin/Release/net10.0-windows/win-x64/mindmap-helper.exe");
export const HELPER_BUILD_COMMAND = "dotnet build -c Release helper";
// ビルド済み（GitHub Releases の mindmap-helper-win-x64 の zip。scripts/win-release-helper.cmd が作る）を展開して置く場所。
// 利用者が .NET SDK や Visual Studio を入れずに使うための置き場（ADR 0006）
export const INSTALLED_HELPER_DIR_NAME = String.raw`%LOCALAPPDATA%\mindmap\helper`;
export const installedHelperPath = (env: Readonly<Record<string, string | undefined>>): string | undefined =>
  env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "mindmap", "helper", "mindmap-helper.exe") : undefined;

// LIVE_MINDMAP_HELPER があればそれを使う。無ければリポジトリの Release のビルド、無ければ展開したビルド済み。
// どれも無いときは Debug に黙って戻らず、用意の仕方を示して失敗する
export function resolveHelperPath(
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean = existsSync,
): { readonly path: string } | { readonly error: string } {
  if (env.LIVE_MINDMAP_HELPER) return { path: env.LIVE_MINDMAP_HELPER };
  if (exists(DEFAULT_HELPER_PATH)) return { path: DEFAULT_HELPER_PATH };
  const installed = installedHelperPath(env);
  if (installed !== undefined && exists(installed)) return { path: installed };
  return {
    error: `ヘルパーの実行ファイルがありません: ${DEFAULT_HELPER_PATH}${installed === undefined ? "" : `（${installed} にも無い）`}\n`
      + `リポジトリのルートで \`${HELPER_BUILD_COMMAND}\` を実行してビルドするか、GitHub Releases の mindmap-helper-win-x64 の zip を ${INSTALLED_HELPER_DIR_NAME} に展開するか、`
      + `LIVE_MINDMAP_HELPER で実行ファイルを指定してください`,
  };
}
