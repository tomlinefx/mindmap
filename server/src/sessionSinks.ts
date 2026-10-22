// セッションの中身（updater・ログ・いま話している文字・書き出し）を開く（上流 ADR 0008）。
// core のセッションを直接使う。updater はセッションの Scope の資源で、Scope を閉じると閉じる。
import { Clock, Context, DateTime, Effect, FileSystem, Layer, Ref, Scope, Semaphore } from "effect";
import type { UpdaterUnavailable } from "./updaterUnavailable.ts";
import type { ExecutableModel } from "./modelSelection.ts";
import { createSessionDir, openLoggedSession, writeSessionExports } from "./sessionFiles.ts";
import { CLOSING_TIMEOUT_MS, DiffUpdater, FAILED_SHOW_MS, dropExpiredPending, hasContent, nameSpeaker, pendingRemarksFrame, samePendingRemarksFrame, type ClosingSegment, type PendingRemarksFrame, type PendingState, speakerNameMap, speakerNamesFrame, type DiffUpdateFrame, type HelperPartial, type IntakeLogEvent, type LogEvent, type SelfPauseLogEvent, type SpeakerNameChange, type SpeakerNameTable, type SpeakerNamesFrame, type SettledRemark, type SpeakerLogEvent, type Snapshot, type CaptionsFrame, type Remark, type Replacement, type WordTime } from "./core/index.ts";
import { createRemarkSettling } from "./remarkSettling.ts";
import { ReviewBuild } from "./review.ts";
import { createSpeakingRelay, type CaptionContext } from "./speakingRelay.ts";
import { SpeakerNameRejected } from "./sessionFailure.ts";
import { errorMessage } from "./truthFile.ts";

// 開いたセッション 1 つ。ヘルパーに依らず、起動し直しをまたいで 1 つを使い続ける
export type SessionSink = {
  dir: string;
  // ヘルパーの途中結果。いま話している文字（speaking）と、1 秒更新されなかった発話の発言化（settling）へ渡す
  partial: (p: HelperPartial) => Effect.Effect<void>;
  // ヘルパーの確定結果。発言は、確定結果と 1 秒更新されなかった途中結果のどちらからも差分更新・ログ・speaking へ届く
  final: (r: SettledRemark) => Effect.Effect<void>;
  // ヘルパーの区間の区切り。そのトラックの最後の途中結果の本文で、取り込み待ちに仮の項目（closing）を入れる。
  // 確定結果が 3 秒来なければ外す
  segmentEnd: (segment: { track: ClosingSegment["track"]; start: number; end: number }) => Effect.Effect<void>;
  // 確定結果に覆われなかった最後の発話を発言にする
  drain: Effect.Effect<void>;
  // いま話している文字を空にする（以後も送れる。取り込みの途切れの瞬間に使う）
  clearSpeaking: Effect.Effect<void>;
  // 予約を取り消し、いま話している文字を空にして、以後は何も送らない
  stopRelays: Effect.Effect<void>;
  // ヘルパーの話者の区間と使えないこと。受け取った値のまま、届いた順に log.jsonl へ残してから、相手の発言の話者を決める段へ渡す。
  // 初版のヘルパーは流さない（話者分離は作らない。ADR 0001）が、イベントの形は上流のまま保つ
  speaker: (event: SpeakerLogEvent) => Effect.Effect<void>;
  // ヘルパーを起動し直して接続できた。新しいヘルパーのイベントを読み始める前に呼ぶ
  speakersRenumbered: Effect.Effect<void>;
  // 話者のラベル（相手 B）に名前を手で付ける。付けられるのは発言に振ったラベルだけで、自分・まだ振っていないラベル・ラベルの無い「相手」・空の名前は SpeakerNameRejected。
  // 表が変わるときだけ、log.jsonl に speaker-name の行を残し、名前の表のフレームを送る。以後の差分更新の入力に載る。名前は外れない
  nameSpeaker: (speaker: { label: string; name: string }) => Effect.Effect<void, SpeakerNameRejected>;
  // log.jsonl へ、取り込みの途切れ・自分の休止等の記録を追記する（話者の記録は speaker が行う）
  appendLog: (event: Exclude<IntakeLogEvent, SpeakerLogEvent> | SelfPauseLogEvent | Extract<LogEvent, { readonly type: "origin" }>) => Effect.Effect<void>;
  // 差分更新の結果を待つ
  flush: Effect.Effect<void>;
  // map.md・map.json・map.drawnix（と書き出せれば map.html）を書き出し、パスを返す
  exports: Effect.Effect<string[]>;
};

export type SessionSinksDeps<R = never> = {
  // モデルから差分更新の layer を作る
  prepareUpdater: (model: ExecutableModel) => Effect.Effect<Layer.Layer<DiffUpdater, UpdaterUnavailable>, UpdaterUnavailable, R | Scope.Scope>;
};

export type OpenSessionSink = {
  model: ExecutableModel;
  updaterLayer: Layer.Layer<DiffUpdater, UpdaterUnavailable>;
  dir: string; // createDir で作ったセッションのフォルダ
  title: string | undefined; // 省略したときは、セッションのフォルダ名（開始時刻）
  publish: (snapshot: Snapshot) => Effect.Effect<void>;
  speak: (frame: CaptionsFrame) => Effect.Effect<void>;
  // 話者の名前の表（全体）を送る。開いた直後に空の表を 1 回送り、前のセッションの名前を消す
  speakerNames: (frame: SpeakerNamesFrame) => Effect.Effect<void>;
  diffUpdate: (frame: DiffUpdateFrame) => Effect.Effect<void>;
  // 取り込み待ちのフレームを送る。省略すると送らない
  pendingRemarks?: (frame: PendingRemarksFrame) => Effect.Effect<void>;
  // 原点の壁時計（ms）を読む。保留の期限の起点で、省略すると壁時計なし（保留に入った時刻から数える）
  originWall?: Effect.Effect<number | undefined>;
};

export class SessionSinks extends Context.Service<SessionSinks, {
  prepare: SessionSinksDeps["prepareUpdater"];
  // セッションのフォルダを作る。起動の前に確定させる。失敗したら以後 open を呼ばない
  createDir: (sessionsDir: string, at?: DateTime.DateTime) => Effect.Effect<string>;
  // セッションの Scope の中で 1 回開く。Scope を閉じると updater が閉じ、予約が止まる
  open: (args: OpenSessionSink) => Effect.Effect<SessionSink, never, Scope.Scope>;
}>()("live-mindmap/server/SessionSinks") {
  // 終了時の書き出しが使う見返し用の HTML のビルドと FileSystem は、Layer を作るときに文脈から 1 回だけ受け取る
  static readonly layer = <R>({ prepareUpdater }: SessionSinksDeps<R>): Layer.Layer<SessionSinks, never, R | ReviewBuild | FileSystem.FileSystem> =>
    Layer.effect(SessionSinks)(
      Effect.gen(function* () {
        const preparationServices = yield* Effect.context<R>();
        const exportServices = Context.pick(ReviewBuild, FileSystem.FileSystem)(
          yield* Effect.context<ReviewBuild | FileSystem.FileSystem>(),
        );
        return SessionSinks.of({
        prepare: (model) => Effect.gen(function* () {
          const scope = yield* Effect.scope;
          return yield* prepareUpdater(model).pipe(Effect.provideContext(Context.add(preparationServices, Scope.Scope, scope)));
        }),
        createDir: (sessionsDir, at) => createSessionDir(sessionsDir, at).pipe(Effect.provideContext(exportServices), Effect.orDie),
        open: Effect.fnUntraced(function* ({ dir, title, publish, speak, speakerNames, diffUpdate, pendingRemarks, model, updaterLayer, originWall }) {
          // updater を開く。Layer はメモ化されるので、Layer.fresh でセッションごとに別の実体にする（query を使い回さない）。
          // 最後の消費者は session.flush の差分更新で、Scope の後始末はそれより後に走る。開けなければ defect
          const updaterContext = yield* Layer.build(Layer.fresh(updaterLayer)).pipe(Effect.orDie);
          // 話者の名前の表（ラベル → 名前）。セッションにつき 1 つで、ヘルパーの起動し直しでは作り直さない。
          // 開いた直後に空の表を送り、前のセッションの名前を画面から消す
          const names = yield* Ref.make<SpeakerNameTable>(new Map());
          const namesLock = yield* Semaphore.make(1);
          yield* speakerNames(speakerNamesFrame(new Map()));
          // 差分更新を呼ぶたびに、そのときの名前の表を入力に載せる（名前が無いときはキーごと付けない）
          const baseUpdater = Context.get(updaterContext, DiffUpdater);
          const namedUpdater = DiffUpdater.of({
            ...baseUpdater,
            update: (input) => Effect.flatMap(Ref.get(names), (table) =>
              baseUpdater.update(table.size === 0 ? input : { ...input, speakerNames: speakerNameMap(table) })),
          });
          // 名前を付ける 1 つの口（手入力も AI の推定も通る）。規則は nameSpeaker にある。
          // Why: 要求が途中で中断されると、表・ログの行・フレームの一部だけが更新され、同じ名前の再送では直らない（同じ値は何もしない）ため、ロック取得後は中断させない
          const applyName = (change: SpeakerNameChange): Effect.Effect<void> =>
            namesLock.withPermit(Effect.uninterruptible(Effect.gen(function* () {
              const next = nameSpeaker(yield* Ref.get(names), change);
              if (next === undefined) return;
              yield* appendRecordedLog({ type: "speaker-name", label: change.label, name: next.get(change.label)!.name, source: change.source });
              yield* Ref.set(names, next);
              yield* speakerNames(speakerNamesFrame(next));
            })));
          // relay を先に作る。context は session と settling ができた後（onDiff・途中結果が走るとき）にだけ評価されるので、Effect.suspend で遅らせる
          // 字幕用の表（発言の id → 本文・wordTimes）。Remark には入れず、未反映の発言を盤へ渡すときだけ上書きする（語ごとの時刻は Remark に残らない）
          const captionTexts = yield* Ref.make<ReadonlyMap<string, { readonly text: string; readonly wordTimes: readonly WordTime[]; readonly replacements: readonly Replacement[] }>>(new Map());
          const relay = yield* createSpeakingRelay({
            context: Effect.suspend((): Effect.Effect<CaptionContext> =>
              Effect.zipWith(session.unreflectedRemarks, Ref.get(captionTexts), (remarks, captions): CaptionContext => ({
                unreflected: remarks.map(({ id, ...remark }) => {
                  const caption = captions.get(id);
                  return caption === undefined ? { id, remark } : { id, remark: { ...remark, text: caption.text, wordTimes: caption.wordTimes }, replacements: caption.replacements };
                }),
                held: settling.preview.heldRemarks(),
                intervals: settling.preview.segments(),
                previewLabel: settling.preview.label,
              })),
            ),
            send: speak,
          });
          // 取り込み待ちのフレーム。保留・順番待ち・呼び出し・外した発言が変わるたびに、そのときの状態から組み直し、前に送った中身と違うときだけ送る。
          // session と settling は後でできるので、参照は Effect.suspend で遅らせる。ロックは葉（Ref を読むだけ）で、保留のロック・セッションの中からも呼べる
          // 仮の項目と取り込めなかった項目の期限は、セッションの Scope に張った外側のファイバーが持つ（Scope を閉じると止まる）。
          // closingRef は確定結果を待つ区間、expiredFailed は 5 秒出して外した発言の ID（外した後に戻さない）、lastPartials はトラックごとの最後の途中結果
          const sessionScope = yield* Effect.scope;
          const closingRef = yield* Ref.make<readonly ClosingSegment[]>([]);
          const expiredFailed = yield* Ref.make<ReadonlySet<string>>(new Set());
          const lastPartials = yield* Ref.make<ReadonlyMap<ClosingSegment["track"], { start: number; text: string }>>(new Map());
          const pendingLock = yield* Semaphore.make(1);
          const lastPending = yield* Ref.make<{ frame: PendingRemarksFrame; states: ReadonlyMap<string, { state: PendingState; since: number }> }>({ frame: { type: "pending-remarks", remarks: [] }, states: new Map() });
          // 発言の項目（track:start の区間ごと）が最初に取り込み待ちのフレームに入った壁時計。仮の項目・保留の項目も数えるので、確定した発言の行へ最初の時刻を渡せる
          const firstShown = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
          // セッションの終わりの後は、期限のファイバーが遅れて動いても、フレームを送らない（保持を戻さない）
          const pendingEnded = yield* Ref.make(false);
          // incoming は、これから session.push で入れる発言。順番待ちとして先にフレームへ載せるので、その発言の行を書くときに最初の時刻が決まっている
          const publishPendingWith = (incoming: readonly Remark[]): Effect.Effect<void> => pendingRemarks === undefined ? Effect.void : pendingLock.withPermit(Effect.gen(function* () {
            if (yield* Ref.get(pendingEnded)) return;
            // 保留 → 順番待ち・取り込み中 → 外した発言、の順に読む。後に読むほど先の状態なので、発言はどの集合からも落ちない
            const heldNow = settling.preview.heldRemarks();
            const { reflecting, queued: queuedNow } = yield* session.pendingBreakdown;
            const queued = [...queuedNow, ...incoming];
            const failedAll = yield* session.failedRemarks;
            // 保留を読んだ後に出た発言は、順番待ち以降にも居る。同じ track・start は、出た先だけを残す
            const slots = new Set([...queued, ...reflecting, ...failedAll].map((r) => `${r.track}:${r.start}`));
            const held = heldNow.filter((r) => !slots.has(`${r.track}:${r.start}`));
            // 確定した発言（保留・順番待ち・取り込み中・外した発言）と同じ区間の仮の項目は、1 度見えたら外す。後で反映されて集合から消えても戻さない
            const confirmed = new Set([...slots, ...heldNow.map((r) => `${r.track}:${r.start}`)]);
            const closing = yield* Ref.modify(closingRef, (current): [readonly ClosingSegment[], readonly ClosingSegment[]] => {
              const kept = current.filter((c) => !confirmed.has(`${c.track}:${c.start}`));
              return [kept, kept];
            });
            const expiredIds = yield* Ref.get(expiredFailed);
            const failed = failedAll.filter((r) => !expiredIds.has(r.id));
            const previous = yield* Ref.get(lastPending);
            const draft = pendingRemarksFrame({ closing, held, queued, reflecting, failed, since: new Map([...previous.states].map(([key, { since }]) => [key, since])) });
            const now = yield* Clock.currentTimeMillis;
            // since は状態が替わったときの壁時計。状態が同じ間は前の値を持ち越す
            const stamped = draft.remarks.map((r) => ({ ...r, since: previous.states.get(r.key)?.state === r.state ? previous.states.get(r.key)!.since : now }));
            // 期限を過ぎた仮の項目・取り込めなかった項目を外し、以後のフレームにも戻さない
            const remarks = dropExpiredPending({ type: "pending-remarks", remarks: stamped }, now).remarks;
            const dropped = stamped.filter((r) => !remarks.includes(r));
            if (dropped.length > 0) {
              yield* Ref.update(closingRef, (current) => current.filter((c) => !dropped.some((r) => r.state === "closing" && r.key === `${c.track}:${c.start}`)));
              yield* Ref.update(expiredFailed, (ids) => new Set([...ids, ...dropped.filter((r) => r.state === "failed").map((r) => r.key)]));
            }
            // 取り込めなかった項目が出たら、外す期限のファイバーを張る（待たない。フレームは期限が来たときに組み直す）
            for (const r of remarks) {
              if (r.state === "failed" && previous.states.get(r.key)?.state !== "failed") {
                yield* Effect.forkIn(Effect.andThen(Effect.sleep(FAILED_SHOW_MS), Effect.suspend(() => publishPending)), sessionScope);
              }
            }
            const frame: PendingRemarksFrame = { type: "pending-remarks", remarks };
            const states = new Map(remarks.map((r) => [r.key, { state: r.state, since: r.since }]));
            if (samePendingRemarksFrame(previous.frame, frame)) {
              yield* Ref.set(lastPending, { frame: previous.frame, states });
              return;
            }
            yield* Ref.set(lastPending, { frame, states });
            yield* pendingRemarks(frame);
            yield* Ref.update(firstShown, (shown) => new Map([...remarks.map((r): [string, number] => [`${r.track}:${r.start}`, now]), ...shown]));
          }));
          const publishPending = publishPendingWith([]);
          // セッションの終わりに、残っている項目を空のフレームで消す。後からつないだクライアントに、終わったセッションの項目を保持から送らない
          const clearPending: Effect.Effect<void> = pendingRemarks === undefined ? Effect.void : pendingLock.withPermit(Effect.gen(function* () {
            yield* Ref.set(pendingEnded, true);
            if ((yield* Ref.get(lastPending)).frame.remarks.length === 0) return;
            const frame: PendingRemarksFrame = { type: "pending-remarks", remarks: [] };
            yield* Ref.set(lastPending, { frame, states: new Map() });
            yield* pendingRemarks(frame);
          }));
          // ログを書くセッションは、反映が終わるたびに onDiff を知らせる。未反映の発言が変わるので、いま話している文字を送り直す
          const { session, appendLog: appendRecordedLog } = yield* openLoggedSession({
            dir,
            title,
            model,
            publish,
            diffUpdate,
            onDiff: relay.flushAll,
            onPendingChange: Effect.suspend(() => publishPending),
            // 根拠の確かめは core が済ませている。1 件ずつ順に、規則（付け替えは名乗りのときだけ）を通して入れる
            onSpeakerNames: (inferred) => Effect.forEach(inferred, ({ label, name, basis }) => applyName({ label, name, source: "推定", basis }), { discard: true }),
          }).pipe(Effect.provideService(DiffUpdater, namedUpdater), Effect.provideContext(exportServices));
          // ID の採番はセッションにつき 1 回だけ作る。起動し直しでは作り直さない
          const count = yield* Ref.make(0);
          // 締めた発言を、採番してセッションへ入れる（ログの remark の行・差分更新・字幕）。
          // words と wordTimes は Remark に入れず、ログの行にだけ残す（語彙補正は初版では無いので、本文は締めたまま）
          const admit = (settled: SettledRemark) =>
            Effect.gen(function* () {
              const { words, wordTimes, ...rest } = settled;
              // 中身なし・重複の印つきの発言は session.push が知らせない。同じ区間の仮の項目を 3 秒待たずに外す
              if (settled.duplicate === true || !hasContent(settled.text)) {
                yield* Ref.update(closingRef, (current) => current.filter((c) => !(c.track === settled.track && c.start === settled.start)));
                yield* publishPending;
              }
              const settledAt = yield* Clock.currentTimeMillis;
              const n = yield* Ref.updateAndGet(count, (c) => c + 1);
              const id = `r${n}`;
              // 語ごとの時刻は、表へ入れる（session.push の前に。push で未反映になった発言を盤が時刻つきで受けるため）。
              // 未反映でなくなった発言の項目は、ここで捨てる
              if (wordTimes !== undefined) {
                const unreflected = new Set((yield* session.unreflectedRemarks).map((r) => r.id));
                const entry = { text: rest.text, wordTimes, replacements: [] };
                yield* Ref.update(captionTexts, (table) => new Map([...table].filter(([key]) => unreflected.has(key)).concat([[id, entry]])));
              }
              const remark: Remark = { ...rest, id };
              // 取り込み待ちに載る発言は、行を書く前にフレームへ載せ、その発言の項目が最初にフレームへ入った時刻を行に残す
              // （区切りで仮の項目が出ていたり保留に入っていたりしたら、その時刻。行の時刻や反映の時刻ではない）
              const shownAt = remark.duplicate !== true && hasContent(remark.text)
                ? yield* Effect.andThen(publishPendingWith([remark]), Effect.map(Ref.get(firstShown), (shown) => shown.get(`${remark.track}:${remark.start}`)))
                : undefined;
              yield* session.push(remark, words === undefined ? undefined : { raw: rest.text, words }, wordTimes, { settledAt, ...(shownAt === undefined ? {} : { shownAt }) });
              yield* relay.remark(rest.track);
            });
          const settling = yield* createRemarkSettling({
            emit: admit,
            holdDeadline: { scope: sessionScope, originWall: originWall ?? Effect.succeed(undefined) },
            onHeldChange: Effect.suspend(() => publishPending),
          });
          // 登録の逆順に走る: 予約を止めてから updater を閉じる
          yield* Effect.addFinalizer(() => Effect.andThen(Effect.andThen(relay.stop, settling.stop), clearPending));

          return {
            dir,
            // 字幕へは、settling が当てはめた後の、もう発言になった分を除いた途中結果を渡す（この結果で出た発言も除く）
            // 仮の項目の本文に使うため、重複の印つき（別の声の漏れ）を除いた最後の途中結果を、トラックごとに覚える
            partial: (p) => Effect.andThen(
              p.duplicate ? Effect.void : Ref.update(lastPartials, (table) => new Map(table).set(p.track, { start: p.start, text: p.text })),
              Effect.andThen(settling.partial(p), Effect.suspend(() => relay.partial(settling.preview.unemittedTail(p)))),
            ),
            final: (r) => settling.final(r),
            segmentEnd: ({ track, start, end }) =>
              Effect.gen(function* () {
                // 本文は同じ区間（start が同じ）の途中結果だけ。無ければ本文なし
                const last = (yield* Ref.get(lastPartials)).get(track);
                const at = yield* Clock.currentTimeMillis;
                const segment: ClosingSegment = { track, start, end, partialText: last?.start === start ? last.text : undefined, at };
                yield* Ref.update(closingRef, (current) => [...current.filter((c) => !(c.track === track && c.start === start)), segment]);
                yield* publishPending;
                yield* Effect.forkIn(Effect.andThen(Effect.sleep(CLOSING_TIMEOUT_MS), Effect.suspend(() => publishPending)), sessionScope);
              }),
            speaker: (event) => Effect.andThen(Effect.andThen(appendRecordedLog(event), settling.speaker(event)), relay.speaker(event)),
            speakersRenumbered: settling.renumbered,
            nameSpeaker: ({ label, name }) =>
              Effect.gen(function* () {
                if (!settling.labels().includes(label)) return yield* new SpeakerNameRejected({ reason: "ラベルがない" });
                if (name.trim() === "") return yield* new SpeakerNameRejected({ reason: "名前が空" });
                yield* applyName({ label, name, source: "手入力" });
              }),
            drain: settling.drain,
            clearSpeaking: relay.clear,
            stopRelays: Effect.andThen(relay.stop, settling.stop),
            appendLog: appendRecordedLog,
            flush: session.flush,
            // テキストの 3 形式を書けないのは予期しない失敗なので defect にする（HTML の失敗は writeSessionExports の中で警告にする）
            exports: Effect.flatMap(Effect.all([session.snapshot, Ref.get(names)]), ([snapshot, table]) => writeSessionExports(dir, snapshot, errorMessage, speakerNameMap(table))).pipe(
              Effect.provideContext(exportServices),
              Effect.orDie,
            ),
          } satisfies SessionSink;
        }),
        });
      }),
    );
}
