// 遅れの集計。セッションのログ（log.jsonl）の時刻から、区間ごと・トラックごとの件数・中央値・p90・最大（ms）を出す純粋な関数。
// 本文（text・raw・words）は読まない: 読む項目だけを宣言した Schema で decode するので、宣言していない項目には触れられない。
// 区間の標本が 1 件も取れないとき（壁時計の無いログ・時刻の項目が無い古いログ）は、その区間を undefined（計測なし）にする。
import { Effect, Predicate, Schema } from "effect";
import { InvalidLogEvent } from "./session.ts";
import { escapeCell } from "./markdownTable.ts";
import { Track } from "./remark.ts";

export type LatencyInterval = "shown" | "applied" | "settled" | "speakerWait" | "callWait" | "call";
export type IntervalStats = { readonly n: number; readonly median: number; readonly p90: number; readonly max: number };
export type LatencyReport = {
  readonly measured: boolean; // origin の wallTime が無ければ false
  readonly byTrack: Readonly<Record<Track, Readonly<Record<LatencyInterval, IntervalStats | undefined>>>>;
};

const INTERVALS: readonly LatencyInterval[] = ["shown", "applied", "settled", "speakerWait", "callWait", "call"];
const TRACKS: readonly Track[] = ["自分", "相手"];

// ここで読む行と項目だけを宣言する（LogEvent は at を宣言しないので使わず、時刻を読むための専用の形を持つ）。
// at は書き手が全行に付ける ISO 文字列
const OriginRow = Schema.Struct({ type: Schema.Literal("origin"), wallTime: Schema.optionalKey(Schema.Finite) });
const RemarkRow = Schema.Struct({
  type: Schema.Literal("remark"),
  remark: Schema.Struct({ id: Schema.String, track: Track, end: Schema.Finite }),
  settledAt: Schema.optionalKey(Schema.Finite),
  shownAt: Schema.optionalKey(Schema.Finite),
  at: Schema.optionalKey(Schema.String),
});
const DiffRow = Schema.Struct({
  type: Schema.Literal("diff"),
  input: Schema.Struct({ fresh: Schema.Array(Schema.String) }),
  error: Schema.optionalKey(Schema.String),
  requeued: Schema.optionalKey(Schema.Literal(true)),
  processedRemarks: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  at: Schema.optionalKey(Schema.String),
  call: Schema.optionalKey(Schema.Struct({ startedAt: Schema.String, endedAt: Schema.String })),
});
const decodeOrigin = Schema.decodeUnknownEffect(OriginRow);
const decodeRemark = Schema.decodeUnknownEffect(RemarkRow);
const decodeDiff = Schema.decodeUnknownEffect(DiffRow);

// 反映した diff の at と、call の開始・終了（いずれも ms。無い項目は undefined）
type Applied = { readonly at: number | undefined; readonly startedAt: number | undefined; readonly endedAt: number | undefined };
type RemarkTimes = {
  readonly track: Track;
  readonly speechEnd: number; // 音声の時刻 0 からの ms（end * 1000）。壁時計にするのは wallTime が分かってから
  readonly settledAt: number | undefined;
  readonly shownAt: number | undefined;
  readonly pushAt: number | undefined;
  applied: Applied | undefined; // この発言を最初に反映した diff
};

const typeOf = (event: unknown): unknown => (Predicate.isObject(event) && "type" in event ? event.type : undefined);

// 昇順に並べた標本の q 分位。位置 (n-1)*q の前後を按分する（線形補間）。中央値は q=0.5（偶数 n は中央の 2 つの平均）
const quantile = (sorted: readonly number[], q: number): number => {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};

const statsOf = (samples: readonly number[]): IntervalStats | undefined => {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  return { n: sorted.length, median: quantile(sorted, 0.5), p90: quantile(sorted, 0.9), max: sorted[sorted.length - 1]! };
};

// 2 つとも時刻があるときだけ差（ms）を標本にする
const diff = (to: number | undefined, from: number | undefined): number | undefined => (to === undefined || from === undefined ? undefined : to - from);

// 行の位置を添えた失敗にする
const failedAt = (index: number) => Effect.mapError((error: { readonly message: string }) => new InvalidLogEvent({ index, reason: error.message }));

// ISO 文字列を ms にする。無ければ undefined、読めない文字列は壊れた行
const parseIso = (index: number, iso: string | undefined): Effect.Effect<number | undefined, InvalidLogEvent> => {
  if (iso === undefined) return Effect.succeed(undefined);
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Effect.fail(new InvalidLogEvent({ index, reason: `時刻として読めません: ${iso}` })) : Effect.succeed(ms);
};

const readRemark = Effect.fnUntraced(function* (index: number, event: unknown): Effect.fn.Return<readonly [string, RemarkTimes], InvalidLogEvent> {
  const e = yield* decodeRemark(event).pipe(failedAt(index));
  const pushAt = yield* parseIso(index, e.at);
  return [e.remark.id, { track: e.remark.track, speechEnd: e.remark.end * 1000, settledAt: e.settledAt, shownAt: e.shownAt, pushAt, applied: undefined }];
});

// diff 1 行が反映した発言の ID と、その反映の時刻。error も requeued も無い回の、fresh の先頭の processedRemarks 件（無ければ全部）だけが反映
const readDiff = Effect.fnUntraced(function* (index: number, event: unknown): Effect.fn.Return<{ readonly ids: readonly string[]; readonly applied: Applied }, InvalidLogEvent> {
  const e = yield* decodeDiff(event).pipe(failedAt(index));
  const at = yield* parseIso(index, e.at);
  const startedAt = yield* parseIso(index, e.call?.startedAt);
  const endedAt = yield* parseIso(index, e.call?.endedAt);
  const applies = e.error === undefined && e.requeued === undefined;
  return { ids: applies ? e.input.fresh.slice(0, e.processedRemarks ?? e.input.fresh.length) : [], applied: { at, startedAt, endedAt } };
});

// ログを順に読んで、origin の壁時計と、発言ごとの時刻を集める
const collect = Effect.fnUntraced(function* (events: Iterable<unknown>): Effect.fn.Return<{ readonly wallTime: number | undefined; readonly remarks: ReadonlyMap<string, RemarkTimes> }, InvalidLogEvent> {
  let wallTime: number | undefined;
  const remarks = new Map<string, RemarkTimes>();
  let index = -1;
  for (const event of events) {
    index++;
    const type = typeOf(event);
    if (type === OriginRow.fields.type.literal) {
      const e = yield* decodeOrigin(event).pipe(failedAt(index));
      wallTime ??= e.wallTime; // セッションで最初の wallTime だけ
    } else if (type === RemarkRow.fields.type.literal) {
      const [id, times] = yield* readRemark(index, event);
      remarks.set(id, times);
    } else if (type === DiffRow.fields.type.literal) {
      const { ids, applied } = yield* readDiff(index, event);
      for (const id of ids) {
        const r = remarks.get(id);
        if (r && r.applied === undefined) r.applied = applied; // 最初に反映した diff
      }
    }
  }
  return { wallTime, remarks };
});

// 発言 1 件が各区間に出す標本（時刻の項目が欠ける区間は出さない）
function sampleOf(r: RemarkTimes, wallTime: number): Partial<Record<LatencyInterval, number | undefined>> {
  const speechEnd = wallTime + r.speechEnd;
  const call = r.applied;
  return {
    shown: diff(r.shownAt, speechEnd),
    settled: diff(r.settledAt, speechEnd),
    speakerWait: diff(r.pushAt, r.settledAt),
    applied: diff(call?.at, speechEnd),
    callWait: diff(call?.startedAt, r.pushAt),
    call: diff(call?.endedAt, call?.startedAt),
  };
}

export const latencyReport = Effect.fnUntraced(function* (events: Iterable<unknown>): Effect.fn.Return<LatencyReport, InvalidLogEvent> {
  const { wallTime, remarks } = yield* collect(events);
  const samples = Object.fromEntries(TRACKS.map((t) => [t, Object.fromEntries(INTERVALS.map((i) => [i, [] as number[]]))])) as Record<Track, Record<LatencyInterval, number[]>>;
  if (wallTime !== undefined) {
    for (const r of remarks.values()) {
      for (const [interval, value] of Object.entries(sampleOf(r, wallTime))) {
        if (value !== undefined) samples[r.track][interval as LatencyInterval].push(value);
      }
    }
  }
  const byTrack = Object.fromEntries(TRACKS.map((t) => [t, Object.fromEntries(INTERVALS.map((i) => [i, statsOf(samples[t][i])]))])) as LatencyReport["byTrack"];
  return { measured: wallTime !== undefined, byTrack };
});

const INTERVAL_LABEL: Readonly<Record<LatencyInterval, string>> = {
  shown: "話し終え → 表示",
  applied: "話し終え → 反映",
  settled: "話し終え → 締まり",
  speakerWait: "話者待ち",
  callWait: "呼び出し待ち",
  call: "呼び出し",
};
const UNMEASURED = "計測なし";

// 遅れの表（cli latency の標準出力）。トラック × 区間で 1 行。値は整数の ms で、標本が無い区間は「計測なし」
export function formatLatencyTable(report: LatencyReport): string {
  const line = (cells: readonly string[]) => `| ${cells.map(escapeCell).join(" | ")} |`;
  const header = ["トラック", "区間", "件数", "中央値(ms)", "p90(ms)", "最大(ms)"];
  const rows = TRACKS.flatMap((track) =>
    INTERVALS.map((interval) => {
      const stats = report.byTrack[track][interval];
      const cells = stats === undefined ? [UNMEASURED, UNMEASURED, UNMEASURED, UNMEASURED] : [stats.n, stats.median, stats.p90, stats.max].map((v) => String(Math.round(v)));
      return line([track, INTERVAL_LABEL[interval], ...cells]);
    }),
  );
  return [line(header), line(header.map(() => "---")), ...rows].join("\n") + "\n";
}
