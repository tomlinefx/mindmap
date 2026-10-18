import { Option } from "effect";
import { REVIEW_AUDIO_ELEMENT_ID, REVIEW_LOG_ELEMENT_ID } from "../../server/src/core/index.ts";
import { runMeeting } from "./app/meeting/entry.ts";
import { runReview } from "./app/review/entry.ts";
import "./styles.css";

// map.html（見返し用）には、書き出しのときにログの出来事が JSON 要素として埋め込まれる。サーバーにはつながない
const reviewLog = document.getElementById(REVIEW_LOG_ELEMENT_ID)?.textContent;

// map-audio.html には、mix した録音が base64 で埋め込まれる。開いたときに Blob にして、その URL を <audio> 1 つに渡す
// （<audio src="data:…"> は WebKit で鳴らない）
const reviewAudio = document.getElementById(REVIEW_AUDIO_ELEMENT_ID)?.textContent;
const audioUrl = reviewAudio == null ? undefined : URL.createObjectURL(new Blob([Uint8Array.from(atob(reviewAudio.trim()), (c) => c.charCodeAt(0))], { type: "audio/mp4" }));

const root = document.getElementById("root")!;
const isMac = navigator.userAgent.indexOf("Mac") >= 0;

// どれも Foldkit の Runtime で起動する。分岐の順序は 見返し → 会議中
if (reviewLog != null) {
  runReview({ container: root, events: JSON.parse(reviewLog), maybeAudioUrl: Option.fromNullishOr(audioUrl), isMac });
} else {
  runMeeting({ container: root, isMac });
}
