import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { WebSocket } from "ws";
import { decodeHelperEvent } from "../src/core/index.ts";
import { DEFAULT_HELPER_PATH, HELPER_BUILD_COMMAND } from "../src/helperPath.ts";

// 実物の helper（Release のビルド）を `run` で起動し、WebSocket で受けた最初のイベントを見る。
// 偽の STT（MINDMAP_STT=fake）にして、モデルが無くても動かす。イベントは音声の取得より前に積まれるので、
// 音声デバイスが無くて helper が終了コード 1 で終わる環境でも、最初の 2 件は届く。
// 会議の文字や録音は使わない（偽の STT は決まった文言を返すだけ）。
const FRAME_WAIT_MS = 15_000;
const SETTLE_MS = 1_500;

type Frame = Record<string, unknown>;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

// helper が待ち受けるまで接続を再試行し、最初のフレームから SETTLE_MS の間に届いたフレームを全部集める
const collectFrames = (port: number) =>
  new Promise<Frame[]>((resolve, reject) => {
    const frames: Frame[] = [];
    const deadline = setTimeout(() => reject(new Error(`helper から ${FRAME_WAIT_MS}ms 以内にイベントが届きませんでした`)), FRAME_WAIT_MS);
    const connect = () => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
      let settle: ReturnType<typeof setTimeout> | undefined;
      socket.on("message", (data) => {
        frames.push(JSON.parse(String(data)) as Frame);
        settle ??= setTimeout(() => {
          clearTimeout(deadline);
          socket.close();
          resolve(frames);
        }, SETTLE_MS);
      });
      socket.on("error", () => { if (settle === undefined) setTimeout(connect, 200); });
    };
    connect();
  });

describe("helper の run の起動直後のイベント列（実物の helper）", () => {
  let dir: string;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mindmap-helper-events-"));
  });
  afterEach(async () => {
    for (const child of children.splice(0)) child.kill();
    await rm(dir, { recursive: true, force: true });
  });

  const run = async (name: string, origin?: string) => {
    if (!existsSync(DEFAULT_HELPER_PATH)) throw new Error(`helper のビルドがありません: ${DEFAULT_HELPER_PATH}（${HELPER_BUILD_COMMAND}）`);
    const port = await freePort();
    const trace = join(dir, `${name}.jsonl`);
    const child = spawn(
      DEFAULT_HELPER_PATH,
      ["run", "--app", "no-such-meeting-app", "--port", String(port), ...(origin === undefined ? [] : ["--origin", origin])],
      { env: { ...process.env, MINDMAP_STT: "fake", MINDMAP_HELPER_TRACE: trace }, stdio: "ignore" },
    );
    children.push(child);
    const frames = await collectFrames(port);
    child.kill();
    const traced = (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Frame);
    return { frames, traced };
  };

  it.skipIf(process.platform !== "win32")("最初の起動: origin（hostTime は数字の文字列、wallTime は今ごろの Unix ms の数値）→ speaker-off 1 件（start 0・理由「モデルなし」）の順で、以後の結果より先に出る", async () => {
    const before = Date.now();
    const { frames, traced } = await run("first");
    const after = Date.now();

    const [origin, speakerOff] = frames;
    expect(origin?.type).toBe("origin");
    expect(origin?.hostTime).toMatch(/^\d+$/);
    expect(typeof origin?.wallTime).toBe("number");
    // 起動した時刻（origin を決めた時刻）が wallTime なので、テストの前後の間に収まる
    expect(origin?.wallTime as number).toBeGreaterThanOrEqual(before - 50);
    expect(origin?.wallTime as number).toBeLessThanOrEqual(after);

    expect(speakerOff).toEqual({ type: "speaker-off", start: 0, reason: "モデルなし" });
    expect(frames.filter((frame) => frame.type === "speaker-off")).toHaveLength(1);
    expect(frames.findIndex((frame) => frame.type === "remark" || frame.type === "partial" || frame.type === "tap-silent")).not.toBe(0);
    for (const later of frames.slice(2)) expect(["remark", "partial", "segment-end", "tap-silent", "self-pause", "self-pause-state"]).toContain(later.type);

    // 送ったイベントの記録（MINDMAP_HELPER_TRACE）も同じ順
    expect(traced.slice(0, 2)).toEqual(frames.slice(0, 2));
  }, 60_000);

  it.skipIf(process.platform !== "win32")("起動し直し（--origin）: 同じ hostTime の origin に、その原点に当たる壁時計（再起動の時刻ではない）を添え、続けて speaker-off を送る", async () => {
    const first = await run("before-restart");
    const hostTime = first.frames[0]?.hostTime as string;
    const firstWall = first.frames[0]?.wallTime as number;
    expect(hostTime).toMatch(/^\d+$/);

    const restarted = await run("after-restart", hostTime);
    const [origin, speakerOff] = restarted.frames;
    expect(origin?.type).toBe("origin");
    expect(origin?.hostTime).toBe(hostTime);
    // 1 回目の収集だけで SETTLE_MS 以上たっているので、「再起動の時刻」を壁時計にする実装は 1 秒以上ずれる
    expect(typeof origin?.wallTime).toBe("number");
    expect(Math.abs((origin?.wallTime as number) - firstWall)).toBeLessThan(250);
    expect(speakerOff).toEqual({ type: "speaker-off", start: 0, reason: "モデルなし" });
    expect(restarted.frames.filter((frame) => frame.type === "speaker-off")).toHaveLength(1);
  }, 60_000);
});

// 16 kHz モノラル 16 bit の wav。声の区間（正弦波）と無音を交互に並べる（会議の録音は使わない）
type Part = { readonly seconds: number; readonly voiced: boolean };
const wav = (parts: ReadonlyArray<Part>) => {
  const rate = 16_000;
  const samples = parts.flatMap(({ seconds, voiced }) =>
    Array.from({ length: Math.round(seconds * rate) }, (_, i) => (voiced ? Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 440 * i) / rate)) : 0)));
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, i) => buffer.writeInt16LE(sample, 44 + i * 2));
  return buffer;
};

// `stt-file` は run と同じ形のイベントを 1 行ずつ標準出力に出す（偽の STT なのでモデルも音声デバイスも要らない）
describe("helper の stt-file の区切り（segment-end）（実物の helper、偽の STT）", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mindmap-helper-sttfile-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sttFile = async (parts: ReadonlyArray<Part>) => {
    if (!existsSync(DEFAULT_HELPER_PATH)) throw new Error(`helper のビルドがありません: ${DEFAULT_HELPER_PATH}（${HELPER_BUILD_COMMAND}）`);
    const path = join(dir, "voice.wav");
    await writeFile(path, wav(parts));
    const done = spawnSync(DEFAULT_HELPER_PATH, ["stt-file", path], { env: { ...process.env, MINDMAP_STT: "fake" }, encoding: "utf8" });
    expect(done.status).toBe(0);
    return done.stdout.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as Frame);
  };

  const twoSentences: ReadonlyArray<Part> = [
    { seconds: 1.2, voiced: true },
    { seconds: 1.5, voiced: false },
    { seconds: 1.2, voiced: true },
  ];

  it.skipIf(process.platform !== "win32")("各 segment-end は、start が同じ確定結果（remark）より先に出て、segment-end と remark は同じ数ずつ出る", async () => {
    const events = await sttFile(twoSentences);
    const ends = events.filter((event) => event.type === "segment-end");
    const remarks = events.filter((event) => event.type === "remark");

    expect(remarks).toHaveLength(2);
    expect(ends).toHaveLength(remarks.length);
    for (const end of ends) {
      const remark = remarks.find((candidate) => candidate.start === end.start);
      expect(remark).toBeDefined();
      expect(events.indexOf(end)).toBeLessThan(events.indexOf(remark as Frame));
    }
  }, 60_000);

  it.skipIf(process.platform !== "win32")("途中結果を出した区間では、partial・segment-end・remark の start が同じ値", async () => {
    const events = await sttFile(twoSentences);
    const [firstEnd] = events.filter((event) => event.type === "segment-end");
    const partials = events.filter((event) => event.type === "partial" && event.start === firstEnd?.start);

    expect(firstEnd).toBeDefined();
    expect(partials.length).toBeGreaterThan(0);
    for (const partial of partials) expect(events.indexOf(partial)).toBeLessThan(events.indexOf(firstEnd as Frame));
    expect(events.find((event) => event.type === "remark")?.start).toBe(firstEnd?.start);
  }, 60_000);

  it.skipIf(process.platform !== "win32")("segment-end は区間の終わり（end は start 以上）を持ち、本文を持たず、run と同じ Schema（track 付き）で decode できる", async () => {
    const events = await sttFile(twoSentences);
    const ends = events.filter((event) => event.type === "segment-end");

    expect(ends.length).toBeGreaterThan(0);
    for (const end of ends) {
      expect(end.end as number).toBeGreaterThanOrEqual(end.start as number);
      expect(end).not.toHaveProperty("text");
      expect(typeof end.track).toBe("string");
      const decoded = await Effect.runPromise(decodeHelperEvent(JSON.stringify(end)));
      expect(decoded).toEqual({ kind: "known", event: end });
    }
  }, 60_000);

  it.skipIf(process.platform !== "win32")("stt-file の出力は全行が JSON のイベントで、remark の形は run と同じ", async () => {
    const events = await sttFile(twoSentences);

    for (const event of events) expect(["partial", "remark", "segment-end"]).toContain(event.type);
    for (const remark of events.filter((event) => event.type === "remark")) {
      expect(Object.keys(remark).sort()).toEqual(["duplicate", "end", "start", "text", "track", "type", "words", "wordTimes"].sort());
    }
  }, 60_000);
});

// `--vad-silence <秒>`（VAD の無音の長さ）は run と stt-file が受ける。偽の STT には VAD が無いので値は使われないが、
// 値の検査（正の数だけ受ける。違えば終了コード 2 と標準エラーの説明）と「省略しても指定しても同じ動き」は偽の STT で見られる
describe("helper の --vad-silence の引数（実物の helper、偽の STT）", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mindmap-helper-vadsilence-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const helper = (args: ReadonlyArray<string>) => {
    if (!existsSync(DEFAULT_HELPER_PATH)) throw new Error(`helper のビルドがありません: ${DEFAULT_HELPER_PATH}（${HELPER_BUILD_COMMAND}）`);
    return spawnSync(DEFAULT_HELPER_PATH, [...args], { env: { ...process.env, MINDMAP_STT: "fake" }, encoding: "utf8", timeout: 30_000 });
  };

  const voicePath = async () => {
    const path = join(dir, "voice.wav");
    await writeFile(path, wav([{ seconds: 1.2, voiced: true }, { seconds: 1.5, voiced: false }, { seconds: 1.2, voiced: true }]));
    return path;
  };

  const shape = (stdout: string) =>
    stdout.split("\n").filter((line) => line.trim().length > 0).map((line) => {
      const event = JSON.parse(line) as Frame;
      return `${String(event.type)}:${String(event.start)}`;
    });

  it.skipIf(process.platform !== "win32").each(["abc", "0", "-1", "0.0"])("run: --vad-silence が正の数でない（%s）と、終了コード 2 で理由を標準エラーに出す", (value) => {
    const done = helper(["run", "--app", "no-such-meeting-app", "--port", "1", "--vad-silence", value]);

    expect(done.status).toBe(2);
    expect(done.stderr).toContain("--vad-silence");
  }, 60_000);

  it.skipIf(process.platform !== "win32").each(["abc", "0", "-1", "0.0"])("stt-file: --vad-silence が正の数でない（%s）と、終了コード 2 で理由を標準エラーに出し、結果を出さない", async (value) => {
    const done = helper(["stt-file", await voicePath(), "--vad-silence", value]);

    expect(done.status).toBe(2);
    expect(done.stderr).toContain("--vad-silence");
    expect(done.stdout.trim()).toBe("");
  }, 60_000);

  it.skipIf(process.platform !== "win32").each(["0.6", "1.5", "0.3"])("stt-file: --vad-silence %s を付けても受け付けられ、省略したときと同じ区間（種類と start）の結果が出る", async (value) => {
    const path = await voicePath();
    const omitted = helper(["stt-file", path]);
    const given = helper(["stt-file", path, "--vad-silence", value]);

    expect(omitted.status).toBe(0);
    expect(given.status).toBe(0);
    expect(shape(given.stdout)).toEqual(shape(omitted.stdout));
  }, 60_000);
});
