// `latency` が出す Markdown の表を、テストから行・セルとして読むための補助。区間の行は、ラベルに含まれる語で 1 行に決める
import type { LatencyInterval } from "../../src/core/index.ts";

export const UNMEASURED = "計測なし";

const INTERVAL_LABEL: Record<LatencyInterval, RegExp> = {
  shown: /表示/,
  applied: /反映/,
  settled: /締まり/,
  speakerWait: /話者待ち/,
  callWait: /呼び出し待ち/,
  call: /呼び出し(?!待ち)/,
};

// 表の行（`|` で始まる行）をセルに分ける。先頭がヘッダー、次が `---` の行、その後がデータ行
export const tableRows = (output: string): string[][] =>
  output.split("\n").filter((line) => line.startsWith("|")).map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()));

export const dataRows = (output: string): string[][] => tableRows(output).slice(2);

// トラック × 区間の 1 行（セルは トラック・区間・件数・中央値・p90・最大 の順）。ちょうど 1 行に決まらなければ失敗させる
export function rowOf(output: string, track: "自分" | "相手", interval: LatencyInterval): string[] {
  const found = dataRows(output).filter((cells) => cells[0] === track && INTERVAL_LABEL[interval].test(cells[1] ?? ""));
  if (found.length !== 1) throw new Error(`${track} の ${interval} の行が ${found.length} 行ある:\n${output}`);
  return found[0]!;
}

// 中央値・p90・最大のすべてが計測なし（件数の列の書き方は問わない）
export const isUnmeasured = (cells: readonly string[]): boolean => cells.slice(3).every((cell) => cell === UNMEASURED);
