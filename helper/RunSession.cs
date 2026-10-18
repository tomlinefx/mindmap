using System.Diagnostics;
using Mindmap.Helper.Audio;
using Mindmap.Helper.Transcription;

namespace Mindmap.Helper;

/// <summary>
/// `run`: 2 トラック（自分 = マイク、相手 = 会議アプリ）を取り、文字にして WebSocket で server へ流す。
/// 時刻の原点は、最初の起動で `origin` として送り、起動し直し（--origin）では server から受け取った値を使う。
/// </summary>
public sealed class RunSession
{
    public const int ExitConfigurationChanged = 75; // マイクの入力の構成が変わって止まった（server/src/core/intake.ts と同じ値）
    private const double TapSilentAfter = 10.0;

    private readonly int port;
    private readonly string app;
    private readonly long origin; // Stopwatch.GetTimestamp() の値。秒 = (now - origin) / Frequency
    private readonly bool firstLaunch;
    private readonly string manual; // none | pause | take
    private readonly Func<ITranscriber> newTranscriber;

    public RunSession(int port, string app, string? originArg, string? selfManual, Func<ITranscriber> newTranscriber)
    {
        this.port = port;
        this.app = app;
        firstLaunch = originArg is null;
        origin = originArg is null ? Stopwatch.GetTimestamp() : long.Parse(originArg, System.Globalization.CultureInfo.InvariantCulture);
        manual = selfManual ?? "none";
        this.newTranscriber = newTranscriber;
    }

    private double Now => (double)(Stopwatch.GetTimestamp() - origin) / Stopwatch.Frequency;

    public async Task<int> Run(CancellationToken cancel)
    {
        var pid = Apps.ResolvePid(app);
        if (pid is null) Console.Error.WriteLine($"会議アプリ {app} は動いていません。音は既定の再生デバイス全体から取ります");
        var exit = new TaskCompletionSource<int>();
        Capture? self = null;
        Capture? other = null;
        var selfPaused = manual == "pause";

        WebSocketServer socket = null!;
        socket = new WebSocketServer(port, Environment.GetEnvironmentVariable("LIVE_MINDMAP_HELPER_CONTROL_TOKEN"), instruction =>
        {
            if (instruction.Type != "self-pause" || self is null) return;
            if (selfPaused == instruction.Paused) return;
            selfPaused = instruction.Paused;
            self.Paused = selfPaused;
            SendSelfPause(selfPaused);
        });
        void SendSelfPause(bool paused)
        {
            socket.Send(Events.SelfPause(paused, Now));
            socket.Send(Events.SelfPauseState(paused ? "pause" : "take"));
        }

        // モデルの読み込みに数秒かかるので、server が接続を待つ間（WebSocket を開く前）に済ませる。開いた時点で取り込みを始められる
        using var selfStt = newTranscriber();
        using var otherStt = newTranscriber();
        selfStt.Label = Track.Self;
        otherStt.Label = Track.Other;

        await using (socket)
        {
            socket.Start();
            if (firstLaunch) socket.Send(Events.Origin(origin));

            try
            {
                self = Capture.Microphone();
                other = pid is int target ? Capture.ProcessLoopback(target) : Capture.Loopback();
            }
            catch (Exception e) when (e is NAudio.MmException or System.Runtime.InteropServices.COMException or InvalidOperationException)
            {
                Console.Error.WriteLine($"音声を取れません: {e.Message}");
                return 1;
            }
            using var selfCapture = self;
            using var otherCapture = other;
            self.Paused = selfPaused;

            Wire(selfCapture, selfStt, Track.Self, socket);
            Wire(otherCapture, otherStt, Track.Other, socket);

            // 相手の音が 10 秒届かなければ知らせる（origin からの秒）
            var lastOtherAudio = Now;
            var tapSilentSent = false;
            otherCapture.OnSamples += (_, _) => { lastOtherAudio = Now; tapSilentSent = false; };
            using var watchdog = new Timer(_ =>
            {
                if (!tapSilentSent && Now - lastOtherAudio >= TapSilentAfter)
                {
                    tapSilentSent = true;
                    socket.Send(Events.TapSilent(Now));
                }
            }, null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));

            // マイクの構成の変化で止まったら 75 で終わる（server が起動し直す）
            selfCapture.OnStopped += e => { if (e is not null) { Console.Error.WriteLine($"マイクの取得が止まりました: {e.Message}"); exit.TrySetResult(ExitConfigurationChanged); } };
            otherCapture.OnStopped += e => { if (e is not null) { Console.Error.WriteLine($"相手の音の取得が止まりました: {e.Message}"); exit.TrySetResult(1); } };

            selfCapture.Start();
            otherCapture.Start();
            if (selfPaused) SendSelfPause(true);
            var otherSource = pid is int p ? $"{app}（PID {p}）の Process Loopback" : "再生デバイスの loopback";
            Console.Error.WriteLine($"取得を始めました（自分: マイク、相手: {otherSource}、ポート {port}）");

            using var registration = cancel.Register(() => exit.TrySetResult(0));
            var code = await exit.Task;
            selfStt.Finish();
            otherStt.Finish();
            return code;
        }

    }

    /// <summary>トラックの取得を STT につなぎ、結果を原点からの秒に直して送る。</summary>
    private void Wire(Capture capture, ITranscriber stt, string track, WebSocketServer socket)
    {
        var trackStart = Now; // トラック内の 0 秒が原点から何秒か
        stt.OnResult += result => socket.Send(Events.Remark(track, result with {
            Start = trackStart + result.Start,
            End = trackStart + result.End,
            WordTimes = result.WordTimes?.Select(w => w with { start = trackStart + w.start, end = trackStart + w.end }).ToList(),
        }));
        capture.OnSamples += stt.Push;
    }
}
