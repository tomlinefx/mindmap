import { Effect } from "effect";

export const readyHelperChecks = {
  check: Effect.succeed({ microphone: "authorized" as const, sttModel: "installed" as const }),
};

export const forbiddenHelperChecks = {
  check: Effect.die("このテストではヘルパーを確認しない"),
};

// readyHelperChecks の check から作られる、開始前の確かめの項目
export const readyHelperItems = [
  { name: "microphone", state: "ready" },
  { name: "stt-model", state: "ready" },
] as const;
