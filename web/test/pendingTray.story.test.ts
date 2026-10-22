import { HashMap, Option } from "effect";
import { given, Mount, scene, tap, textContent } from "foldkit/scene";
import { given as givenStory, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";
import type { PendingRemark, Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { init as initFeed, update as updateFeed } from "../src/app/liveFeed/main.ts";
import { Message as FeedMessage } from "../src/app/liveFeed/message.ts";
import { init as initSurface, type Model as SurfaceModel, update, view } from "../src/app/mapSurface/main.ts";
import { Message as SurfaceMessage } from "../src/app/mapSurface/message.ts";
import { ObserveMapSurface } from "../src/app/mapSurface/mount.ts";

// 取り込み待ちの一覧（map-update-latency 6.5）。
// 前半: liveFeed の update に pending-remarks のフレームを流し、Model が持つ・空のフレームと切断で消えることを見る。
// 後半: mapSurface の view を描き、今の議題のノードの近くに、話者・本文・状態の語が、ノードと別の見た目で出ることを見る。本文は作り物の短い文。

type VNode = Parameters<typeof textContent>[0];
const app = { update, view };

const remark = (extra: Partial<PendingRemark> = {}): PendingRemark => ({ key: "相手:1", track: "相手", text: "予算の話", start: 1, end: 2, state: "queued", since: 0, ...extra });
const frame = (...remarks: PendingRemark[]) => ({ type: "pending-remarks" as const, remarks });
const receivedMessage = (f: ReturnType<typeof frame>) => FeedMessage.ReceivedLiveFrame({ frame: f, receivedAt: 0 });
const received = (f: ReturnType<typeof frame>) => message(receivedMessage(f));

describe("liveFeed の update: 取り込み待ちのフレーム", () => {
  it("初期値は None。フレームを受けると Some で持ち、ほかの値は変えない", () => {
    expect(initFeed().pendingRemarks).toEqual(Option.none());
    const f = frame(remark());
    story(
      updateFeed,
      givenStory(initFeed()),
      received(f),
      model((m) => {
        expect(m.pendingRemarks).toEqual(Option.some(f));
        expect(m.snapshot).toEqual(Option.none());
        expect(m.screenNotice).toEqual(Option.none());
      }),
    );
  });

  it("次のフレームは置き換える（足さない）。remarks が空のフレームで None に戻る（空の Some を持たない）", () => {
    const second = frame(remark({ key: "相手:5", start: 5, end: 6 }));
    story(
      updateFeed,
      givenStory(initFeed()),
      received(frame(remark())),
      received(second),
      model((m) => expect(m.pendingRemarks).toEqual(Option.some(second))),
      received(frame()),
      model((m) => expect(m.pendingRemarks).toEqual(Option.none())),
    );
  });

  it("切れると消え、つなぎ直して届いたフレームで置き換わる", () => {
    const again = frame(remark({ text: "再接続後" }));
    story(
      updateFeed,
      givenStory(initFeed()),
      received(frame(remark())),
      message(FeedMessage.DisconnectedLiveFeed()),
      model((m) => expect(m.pendingRemarks).toEqual(Option.none())),
      received(frame(remark())),
      message(FeedMessage.ConnectedLiveFeed()),
      model((m) => expect(m.pendingRemarks).toEqual(Option.none())),
      received(again),
      model((m) => expect(m.pendingRemarks).toEqual(Option.some(again))),
    );
  });
});

const node = (id: string, parent: string | null, kind: SnapshotNode["kind"]): SnapshotNode => ({ id, parent, kind, text: id, evidence: parent ? ["r1"] : [] });
const snap = (extra: Partial<Snapshot> = {}): Snapshot => ({ nodes: [node("root", null, "会議"), node("A", "root", "議題"), node("B", "root", "議題")], round: 3, changes: [], remarks: [], currentTopic: "B", now: 100, ...extra });
const HEIGHTS = { root: 40, A: 50, B: 70 };

const modelWith = (remarks: PendingRemark[], opts: { mode?: SurfaceModel["mode"]; snapshot?: Snapshot; heights?: Record<string, number>; names?: Record<string, string> } = {}): SurfaceModel => ({
  ...initSurface(opts.snapshot ?? snap(), opts.mode ?? "live", false),
  size: Option.some({ width: 800, height: 600 }),
  nodeHeights: HashMap.make(...Object.entries(opts.heights ?? HEIGHTS)),
  speakerNames: opts.names ?? {},
  pendingRemarks: remarks,
});

const descendants = (v: VNode): VNode[] => [v, ...(v.children ?? []).flatMap((c) => (typeof c === "string" ? [] : descendants(c)))];
const classOf = (v: VNode): string[] => {
  const classes = (v.data?.class as Record<string, boolean> | undefined) ?? {};
  return Object.keys(classes).filter((c) => classes[c]);
};
const withClass = (html: VNode, name: string): VNode[] => descendants(html).filter((v) => classOf(v).includes(name));
const textOf = (v: VNode | string): string => (typeof v === "string" ? v : (v.text ?? "") + (v.children ?? []).map((c) => textOf(c as VNode | string)).join(""));
const items = (html: VNode) => withClass(html, "pending-tray__item");
const part = (item: VNode, name: string): VNode => {
  const found = withClass(item, name);
  expect(found, name).toHaveLength(1);
  return found[0]!;
};
const inViewport = (html: VNode, target: VNode): boolean =>
  descendants(html).some((v) => ((v.data?.style as Record<string, string> | undefined)?.transform ?? "").includes("scale(") && descendants(v).includes(target));

// scene は 1 回描いて tap で取り出す。Mount は大きさだけの測定で resolve する（測った高さは Model に入れてある）
const mounted = Mount.resolve(ObserveMapSurface, SurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: {} }));
const htmlOf = (m: SurfaceModel): VNode => {
  let html: VNode | undefined;
  scene(app, given(m), mounted, tap((s) => void (html = s.html)));
  return html!;
};

describe("mapSurface の view: 取り込み待ちの一覧", () => {
  it("live で今の議題が測れていれば、一覧が 1 つ、拡大縮小する面の中に出る。ノード（map-node）の見た目は使わない", () => {
    const html = htmlOf(modelWith([remark()]));
    const trays = withClass(html, "pending-tray");
    expect(trays).toHaveLength(1);
    expect(inViewport(html, trays[0]!)).toBe(true);
    expect(descendants(trays[0]!).some((v) => classOf(v).includes("map-node"))).toBe(false);
  });

  it("項目は話者・本文・状態の語を、音声の終わりの順に出す。話者は名前の表の名前、名前が無いラベルと話者なしはトラック", () => {
    const html = htmlOf(
      modelWith(
        [
          remark({ key: "a", speaker: "相手 B", text: "一つ目", start: 1, end: 2, state: "queued" }),
          remark({ key: "b", speaker: "相手 C", text: "二つ目", start: 3, end: 4, state: "reflecting" }),
          remark({ key: "c", track: "自分", text: "三つ目", start: 5, end: 6, state: "waiting" }),
          remark({ key: "d", text: "四つ目", start: 7, end: 8, state: "closing" }),
          remark({ key: "e", text: "五つ目", start: 9, end: 10, state: "failed" }),
        ],
        { names: { "相手 B": "田中" } },
      ),
    );
    expect(items(html).map((v) => ({ speaker: textOf(part(v, "pending-tray__speaker")), text: textOf(part(v, "pending-tray__text")), state: textOf(part(v, "pending-tray__state")) }))).toEqual([
      { speaker: "田中", text: "一つ目", state: "待ち" },
      { speaker: "相手 C", text: "二つ目", state: "取り込み中" },
      { speaker: "自分", text: "三つ目", state: "話者待ち" },
      { speaker: "相手", text: "四つ目", state: "聞き取り中" },
      { speaker: "相手", text: "五つ目", state: "取り込めなかった" },
    ]);
  });

  it("仮（closing）の本文だけ薄く、本文が空なら「…」。取り込めなかった項目だけ警告の見た目", () => {
    const html = htmlOf(
      modelWith([
        remark({ key: "a", text: "確定", state: "queued", start: 1, end: 2 }),
        remark({ key: "b", text: "仮の文", state: "closing", start: 3, end: 4 }),
        remark({ key: "c", text: "", state: "closing", start: 5, end: 6 }),
        remark({ key: "d", text: "失敗", state: "failed", start: 7, end: 8 }),
      ]),
    );
    const rows = items(html);
    expect(rows.map((v) => classOf(part(v, "pending-tray__text")).includes("pending-tray__text--tentative"))).toEqual([false, true, true, false]);
    expect(textOf(part(rows[2]!, "pending-tray__text"))).toBe("…");
    expect(rows.map((v) => classOf(v).includes("pending-tray__item--failed"))).toEqual([false, false, false, true]);
  });

  it("仮から確定に替わっても同じ鍵の要素のまま、本文と状態だけが替わる（作り直さない）", () => {
    const before = items(htmlOf(modelWith([remark({ key: "相手:1", text: "予算", state: "closing" })])))[0]!;
    const after = items(htmlOf(modelWith([remark({ key: "r7", id: "r7", text: "予算の上限を決める", state: "queued" })])))[0]!;
    expect(before.key).toBeDefined();
    expect(after.key).toBe(before.key);
    expect(textOf(part(before, "pending-tray__state"))).toBe("聞き取り中");
    expect(textOf(part(after, "pending-tray__text"))).toBe("予算の上限を決める");
    expect(textOf(part(after, "pending-tray__state"))).toBe("待ち");
  });

  it("別の発言（start が違う）は別の鍵になる", () => {
    const rows = items(htmlOf(modelWith([remark({ key: "x", start: 1, end: 2 }), remark({ key: "y", start: 3, end: 4 })])));
    expect(new Set(rows.map((v) => v.key)).size).toBe(2);
  });

  it("remarks が空なら一覧の要素は出ない（空の枠を描かない）", () => {
    expect(withClass(htmlOf(modelWith([])), "pending-tray")).toHaveLength(0);
  });

  it("still・review では出さない", () => {
    for (const mode of ["still", "review"] as const) expect(withClass(htmlOf(modelWith([remark()], { mode })), "pending-tray")).toHaveLength(0);
  });

  it("今の議題が無い、または今の議題をまだ測れていないときは出さない", () => {
    expect(withClass(htmlOf(modelWith([remark()], { snapshot: snap({ currentTopic: undefined }) })), "pending-tray")).toHaveLength(0);
    expect(withClass(htmlOf(modelWith([remark()], { heights: { root: 40, A: 50 } })), "pending-tray")).toHaveLength(0);
  });
});
