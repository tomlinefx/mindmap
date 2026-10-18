// 共有画面を使っていないことの一文（screen-off の許可なし。Issue #280）。ブラウザへ送るフレームと文言と寿命。
// Node の実行環境に依存しない（ADR 0003）。タイマーは持たない（寿命は配線側が使う）。
import { Schema } from "effect";

// ブラウザへ送るフレーム。text が null のときは一文を消す。type で他のフレームと見分ける
export const ScreenNoticeFrame = Schema.Struct({ type: Schema.Literal("screen-notice"), text: Schema.NullOr(Schema.String) });
export type ScreenNoticeFrame = typeof ScreenNoticeFrame["Type"];
