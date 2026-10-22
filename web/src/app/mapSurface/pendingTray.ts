// 取り込み待ちの一覧（map-update-latency）の view。今の議題のノードの近くに、話者・本文の先頭・状態を出す。
// ノードと見分けられるよう、点線の枠で種類色の塗りは使わない（見た目は styles.css の .pending-tray）。純粋に h と remarks と名前の表から Html を作る
import type { Html, HtmlBuilder } from "foldkit/html";
import { type PendingRemark, type PendingState, speakerName, type SpeakerNames } from "../../../../server/src/core/index.ts";
import { NODE_WIDTH, type Position } from "../../layout.ts";
import type { Message } from "./message.ts";

const STATE_WORD: Record<PendingState, string> = { closing: "聞き取り中", waiting: "話者待ち", queued: "待ち", reflecting: "取り込み中", failed: "取り込めなかった" };
const EMPTY_TEXT = "…";

const classes = (...names: ReadonlyArray<string | false>): string => names.filter(Boolean).join(" ");

// 話者は名前の表の名前、名前が無いラベルはラベル、話者なしの相手と話者なしはトラック
const speakerOf = (remark: PendingRemark, names: SpeakerNames): string => speakerName(remark.speaker ?? remark.track, names) ?? remark.track;

// 仮から確定に替わると PendingRemark.key は `${track}:${start}` から ID に替わる。要素の鍵は替わらない `${track}:${start}` にして、作り直さない
const slotKey = (remark: PendingRemark): string => `${remark.track}:${remark.start}`;

// at は今の議題のノードの位置（拡大縮小する面の座標）。ノードの左端に揃えて、上端から上へ伸ばす
export function pendingTray(h: HtmlBuilder<Message>, remarks: ReadonlyArray<PendingRemark>, speakerNames: SpeakerNames, at: Position): Html {
  return h.div(
    [h.Class("pending-tray absolute left-0 top-0 pointer-events-none"), h.Style({ left: `${at.x}px`, top: `${at.y}px`, width: `${NODE_WIDTH}px`, transform: "translateY(-100%)" })],
    remarks.map((remark) =>
      h.keyed("div")(
        slotKey(remark),
        [h.Class(classes("pending-tray__item", remark.state === "failed" && "pending-tray__item--failed"))],
        [
          h.span([h.Class("pending-tray__speaker")], [speakerOf(remark, speakerNames)]),
          h.span([h.Class(classes("pending-tray__text", remark.state === "closing" && "pending-tray__text--tentative"))], [remark.text === "" ? EMPTY_TEXT : remark.text]),
          h.span([h.Class("pending-tray__state")], [STATE_WORD[remark.state]]),
        ],
      ),
    ),
  );
}
