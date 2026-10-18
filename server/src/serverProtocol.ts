// CLI と server の間の要求・応答の形（上流 ADR 0023）。
// 経路ごとに { method, path, body?, response } を 1 つの値にして、この 1 か所に並べる。CLI は記述とその本文を渡して要求を組み、
// server は同じ記述で経路を張って応答を書き出す。本文の Schema もここに置く（web は型だけを import する）。
// 失敗（ステータスと { error } の本文）は経路に宣言しない。失敗からステータスへの対応は http.ts の表 1 つが持つ。
// effect の Schema だけを import する純粋なモジュール（web の型検査が Node の型や effect/http に依存しないように）。
import { Option, Schema, SchemaGetter } from "effect";
import { IntakeStatusReport } from "./core/intake.ts";
import { OpenShareStatus, ShareStatus } from "./core/viewingShare.ts";
import { ExecutableModel } from "./modelSelection.ts";
import { CheckReport } from "./startupCheck.ts";

// title は文字列か null か無し。null は無しにする
const OptionalTitle = Schema.optionalKey(Schema.NullOr(Schema.String)).pipe(
  Schema.decodeTo(Schema.optionalKey(Schema.String), {
    decode: SchemaGetter.transformOptional((title) => Option.filter(title, (value) => value !== null)),
    encode: SchemaGetter.passthrough(),
  }),
);

// /session/start の本文。app は空でない文字列（会議アプリの識別子。trim・形式・長さの制限は足さない）。
// model は CLI が決めた差分更新のモデル。省略すると組み込みの claude
export const SessionStartBody = Schema.Struct({
  app: Schema.NonEmptyString,
  title: OptionalTitle,
  model: Schema.optionalKey(ExecutableModel),
});

// /session/self-pause の本文。状態を指定する形（トグルではない）なので、同じ指示を重ねても結果が変わらない
export const SelfPauseBody = Schema.Struct({ paused: Schema.Boolean });

// /session/speaker-name の本文。ラベルに付ける名前（付けられるラベルかどうか・名前が空かどうかはサーバーが決める）
export const SpeakerNameBody = Schema.Struct({ label: Schema.String, name: Schema.String });

const StartedSession = Schema.Struct({ dir: Schema.String });
const StoppedSession = Schema.Struct({ paths: Schema.Array(Schema.String) });
// 待ち受けているサーバー自身の PID。cli server stop は、記録の PID ではなくこれで終わるのを待つ（serverProcess.ts）
const ServerIdentity = Schema.Struct({ pid: Schema.Int.check(Schema.isGreaterThan(0)) });

export type ServerRoute = {
  readonly method: "GET" | "POST";
  readonly path: `/${string}`;
  readonly body?: Schema.Top;
  // 本文なしの応答（204 と /ws の upgrade）は Void
  readonly response: Schema.Top;
};

export const ServerRoutes = {
  apps: { method: "GET", path: "/apps", response: Schema.Unknown }, // ヘルパーの `list` の結果。形は決めていない
  sessionStart: { method: "POST", path: "/session/start", body: SessionStartBody, response: StartedSession },
  sessionStop: { method: "POST", path: "/session/stop", response: StoppedSession },
  sessionStatus: { method: "GET", path: "/session/status", response: IntakeStatusReport },
  sessionResume: { method: "POST", path: "/session/resume", response: Schema.Void }, // 204
  sessionSelfPause: { method: "POST", path: "/session/self-pause", body: SelfPauseBody, response: Schema.Void }, // 204
  sessionSpeakerName: { method: "POST", path: "/session/speaker-name", body: SpeakerNameBody, response: Schema.Void }, // 204
  shareOpen: { method: "POST", path: "/share/open", response: OpenShareStatus }, // 閲覧の共有を開く（すでに開いていれば今の状態を返す）
  shareClose: { method: "POST", path: "/share/close", response: ShareStatus }, // 閉じる（開いていなくても成功する）
  shareStatus: { method: "GET", path: "/share/status", response: ShareStatus },
  server: { method: "GET", path: "/server", response: ServerIdentity },
  // サーバー自身に終了を求める（204 を返した後に後片付けして終わる）。Windows にはシグナルが無いので、cli server stop はこれで止める
  serverStop: { method: "POST", path: "/server/stop", response: Schema.Void },
  check: { method: "GET", path: "/check", response: CheckReport }, // 開始前の確かめ（ヘルパーの check）
  feed: { method: "GET", path: "/ws", response: Schema.Void }, // ブラウザへの配信（WebSocket の upgrade）
} as const satisfies Record<string, ServerRoute>;
