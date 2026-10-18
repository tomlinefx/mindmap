import { describe, expect, it } from "vitest";
import { DEFAULT_HELPER_PATH, HELPER_BUILD_COMMAND, INSTALLED_HELPER_DIR_NAME, installedHelperPath, resolveHelperPath } from "../src/helperPath.ts";

describe("resolveHelperPath", () => {
  const localAppData = String.raw`C:\Users\someone\AppData\Local`;
  const installed = installedHelperPath({ LOCALAPPDATA: localAppData })!;

  it("既定は最適化ありのビルド（Release）の実行ファイル", () => {
    expect(DEFAULT_HELPER_PATH.split(/[\\/]/).slice(-6).join("/")).toBe("helper/bin/Release/net10.0-windows/win-x64/mindmap-helper.exe");
    expect(resolveHelperPath({}, () => true)).toEqual({ path: DEFAULT_HELPER_PATH });
  });

  it("LIVE_MINDMAP_HELPER を指定したときは、その実行ファイルを使う（既定の有無を見ない）", () => {
    const exists = () => false;
    expect(resolveHelperPath({ LIVE_MINDMAP_HELPER: "/tmp/fake-helper" }, exists)).toEqual({ path: "/tmp/fake-helper" });
  });

  it("リポジトリのビルドが無ければ、%LOCALAPPDATA%\\mindmap\\helper に展開したビルド済みを使う（ADR 0006）", () => {
    expect(installed.split(/[\\/]/).slice(-3).join("/")).toBe("mindmap/helper/mindmap-helper.exe");
    expect(installed.startsWith(localAppData)).toBe(true);
    expect(resolveHelperPath({ LOCALAPPDATA: localAppData }, (path) => path === installed)).toEqual({ path: installed });
    // リポジトリのビルドがあれば、そちらを優先する
    expect(resolveHelperPath({ LOCALAPPDATA: localAppData }, () => true)).toEqual({ path: DEFAULT_HELPER_PATH });
  });

  it("どれも無ければ、Debug に戻らず、ビルドのコマンドとビルド済みの置き場を示して失敗する", () => {
    const result = resolveHelperPath({ LOCALAPPDATA: localAppData }, () => false);
    expect(result).not.toHaveProperty("path");
    const error = "error" in result ? result.error : "";
    expect(error).toContain(HELPER_BUILD_COMMAND);
    expect(error).toContain(INSTALLED_HELPER_DIR_NAME);
    expect(error).toContain(installed);
    // LOCALAPPDATA が無い環境（Windows 以外）でも、文面は組める
    expect("error" in resolveHelperPath({}, () => false)).toBe(true);
  });
});
