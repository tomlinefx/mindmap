// 取り込み待ち（map-update-latency）のフレームの中身を組む規則。純粋関数だけで、壁時計は引数で受ける。
// 区間が閉じて確定結果を待つ項目・話者待ち・差分更新待ち・取り込み中・取り込めなかった、を重複なく 1 つのフレームに組む。
import { Schema } from "effect";
import type { Remark } from "./remark.ts";
import { Track } from "./remark.ts";
import { hasContent } from "./session.ts";
import type { SettledRemark } from "./settle.ts";

export const PENDING_TEXT_MAX = 120; // 表示用に切る本文の長さ（文字数）
export const CLOSING_TIMEOUT_MS = 3000; // 区間が閉じてから、確定結果が来ない仮の項目を外すまで
export const FAILED_SHOW_MS = 5000; // 取り込めなかった項目を出し続ける長さ

// closing: 区間が閉じ、確定結果を待っている（本文は途中結果。仮） / waiting: 話者待ちで保留中
// queued: 差分更新を待っている / reflecting: 呼び出しの結果を待っている / failed: 取り込めなかった
export const PendingState = Schema.Literals(["closing", "waiting", "queued", "reflecting", "failed"]);
export type PendingState = typeof PendingState.Type;

export const PendingRemark = Schema.Struct({
  key: Schema.String, // 表示の項目の鍵。closing と waiting の間は `${track}:${start}`、ID を持つ発言は ID
  id: Schema.optionalKey(Schema.String), // 発言の ID。closing と waiting の間は無い
  track: Track,
  speaker: Schema.optionalKey(Schema.String),
  text: Schema.String, // 表示用に先頭を切った本文。closing で途中結果が無ければ空
  start: Schema.Finite, // 音声の始まり（秒）
  end: Schema.Finite, // 音声の終わり（秒）
  state: PendingState,
  since: Schema.Finite, // この状態になった壁時計（ms）
});
export type PendingRemark = typeof PendingRemark.Type;

export const PendingRemarksFrame = Schema.Struct({
  type: Schema.Literal("pending-remarks"),
  remarks: Schema.Array(PendingRemark), // 音声の終わりの順
});
export type PendingRemarksFrame = typeof PendingRemarksFrame.Type;

// 区間が閉じて確定結果を待っている項目
export type ClosingSegment = {
  readonly track: Track;
  readonly start: number;
  readonly end: number;
  readonly partialText: string | undefined;
  readonly at: number;
};

// 同じ状態の中で後ろほど優先が低い。同じ ID（無ければ track と start）が複数の集合にあれば、優先の高い 1 件だけを出す
const PRIORITY: readonly PendingState[] = ["failed", "reflecting", "queued", "waiting", "closing"];

const slotKey = (r: { readonly track: Track; readonly start: number }): string => `${r.track}:${r.start}`;
const cut = (text: string): string => {
  const chars = Array.from(text);
  return chars.length <= PENDING_TEXT_MAX ? text : chars.slice(0, PENDING_TEXT_MAX).join("");
};

// 状態ごとの集合から、重複のない 1 つのフレームを組む。
// 確定した発言（held・queued・reflecting・failed）と同じ track・start の closing は出さない。
// 確定した発言が中身なし・重複の印つきなら、closing も確定も出ない（締まった時点で反映されないことが決まっている）。
// since は鍵で引く。無ければ closing は at、ほかは 0
export function pendingRemarksFrame(input: {
  readonly closing: readonly ClosingSegment[];
  readonly held: readonly SettledRemark[];
  readonly queued: readonly Remark[];
  readonly reflecting: readonly Remark[];
  readonly failed: readonly Remark[];
  readonly since: ReadonlyMap<string, number>;
}): PendingRemarksFrame {
  const confirmed = new Set<string>();
  const items = new Map<string, PendingRemark>();
  const add = (item: PendingRemark): void => {
    const current = items.get(item.key);
    if (current === undefined || PRIORITY.indexOf(item.state) < PRIORITY.indexOf(current.state)) items.set(item.key, item);
  };
  const settle = (r: SettledRemark | Remark, state: PendingState): void => {
    confirmed.add(slotKey(r));
    if (r.duplicate === true || !hasContent(r.text)) return;
    const id = "id" in r ? r.id : undefined;
    const key = id ?? slotKey(r);
    add({
      key,
      ...(id === undefined ? {} : { id }),
      track: r.track,
      ...(r.speaker === undefined ? {} : { speaker: r.speaker }),
      text: cut(r.text),
      start: r.start,
      end: r.end,
      state,
      since: input.since.get(key) ?? 0,
    });
  };
  for (const r of input.held) settle(r, "waiting");
  for (const r of input.queued) settle(r, "queued");
  for (const r of input.reflecting) settle(r, "reflecting");
  for (const r of input.failed) settle(r, "failed");
  for (const c of input.closing) {
    if (confirmed.has(slotKey(c))) continue;
    const key = slotKey(c);
    add({ key, track: c.track, text: cut(c.partialText ?? ""), start: c.start, end: c.end, state: "closing", since: input.since.get(key) ?? c.at });
  }
  // Map は挿入順を保ち、sort は安定なので、end が同じ項目は入力の順に並ぶ
  return { type: "pending-remarks", remarks: [...items.values()].sort((a, b) => a.end - b.end) };
}

// 2 つのフレームが同じ中身か。remarks の並び（音声の終わりの順）も表示の一部なので順序を含めて比べる。
// since は比べない。since は状態が替わるときにしか替わらず、替われば state が違うため
export function samePendingRemarksFrame(a: PendingRemarksFrame, b: PendingRemarksFrame): boolean {
  return a.remarks.length === b.remarks.length && a.remarks.every((x, i) => {
    const y = b.remarks[i];
    return y !== undefined && x.key === y.key && x.id === y.id && x.track === y.track && x.speaker === y.speaker && x.text === y.text
      && x.start === y.start && x.end === y.end && x.state === y.state;
  });
}

// 期限の時刻 now で、仮の項目（since + CLOSING_TIMEOUT_MS）と取り込めなかった項目（since + FAILED_SHOW_MS）を外す。
// 話者待ち・差分更新待ち・取り込み中は期限で外れない
export function dropExpiredPending(frame: PendingRemarksFrame, now: number): PendingRemarksFrame {
  return {
    type: frame.type,
    remarks: frame.remarks.filter((r) =>
      r.state === "closing" ? r.since + CLOSING_TIMEOUT_MS > now
      : r.state === "failed" ? r.since + FAILED_SHOW_MS > now
      : true),
  };
}
