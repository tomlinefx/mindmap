// CLI と server の受け渡しを 1 つの共有モジュール（serverProtocol）にする（上流 Issue #1308）。
//
// ここでは共有モジュールだけを直接見る（Schema の decode と経路の記述の値）。HTTP の往復は http.it / http.heavy が持つ。
//   - 本文の既定値の補完は本文の Schema の decode で 1 回だけ行う（title の null は無し）。null は今まで通り受ける（手で送った本文の互換）。
//   - 経路は 13 本が { method, path, body?, response } の値として並ぶ。
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { defaultClaude } from "../src/modelSelection.ts";
import { ServerRoutes, SessionStartBody } from "../src/serverProtocol.ts";

const decodeStart = Schema.decodeUnknownSync(SessionStartBody);

describe("/session/start の本文の decode", () => {
  it("title が null のとき、title は無しになる", () => {
    expect(decodeStart({ app: "zoom.exe", title: null })).toEqual({ app: "zoom.exe" });
  });

  it("欄を省略したとき、title も model も無し", () => {
    expect(decodeStart({ app: "zoom.exe" })).toEqual({ app: "zoom.exe" });
  });

  it("指定した値は既定値で上書きしない（空の title・空白だけの app・model）", () => {
    expect(decodeStart({ app: " ", title: "", model: defaultClaude })).toEqual({ app: " ", title: "", model: defaultClaude });
  });

  it("形が合わない model は decode に失敗する", () => {
    expect(() => decodeStart({ app: "zoom.exe", model: { name: "apple", route: "apple", local: true } })).toThrow();
  });

  it("空の app は decode に失敗する", () => {
    expect(() => decodeStart({ app: "" })).toThrow();
  });
});

describe("経路の記述", () => {
  const routes = Object.values(ServerRoutes);

  it("14 本の method と path が、今の server の経路と一致する", () => {
    expect(routes.map(({ method, path }) => `${method} ${path}`).sort()).toEqual(
      [
        "GET /apps",
        "POST /session/start",
        "POST /session/stop",
        "GET /session/status",
        "POST /session/resume",
        "POST /session/self-pause",
        "POST /session/speaker-name",
        "POST /share/open",
        "POST /share/close",
        "GET /share/status",
        "GET /server",
        "POST /server/stop",
        "GET /check",
        "GET /ws",
      ].sort(),
    );
  });
});
