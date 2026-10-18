using Mindmap.Helper.Audio;
using NAudio.Wave;

namespace Mindmap.Helper;

/// <summary>
/// 開発用 `capture-wav`: マイク（self）か相手の音（other）を N 秒録って 16 kHz モノラルの wav に書く。取得の確かめ用。
/// other は会議アプリの id を渡せばそのプロセスの Process Loopback、渡さなければ再生デバイス全体の loopback。
/// </summary>
public static class CaptureFile
{
    public static int Run(string track, int seconds, string path, string? app)
    {
        int? pid = null;
        if (track == "other" && app is not null)
        {
            pid = Apps.ResolvePid(app);
            if (pid is null) { Console.Error.WriteLine($"会議アプリ {app} は動いていません"); return 1; }
            Console.Error.WriteLine($"{app}（PID {pid}）の Process Loopback で取ります");
        }
        using var capture = track == "self" ? Capture.Microphone() : pid is int target ? Capture.ProcessLoopback(target) : Capture.Loopback();
        using var writer = new WaveFileWriter(path, new WaveFormat(Capture.TargetRate, 16, 1));
        var started = DateTime.UtcNow;
        long total = 0;
        var gate = new object();
        capture.OnSamples += (samples, _) =>
        {
            lock (gate)
            {
                writer.WriteSamples(samples, 0, samples.Length);
                total += samples.Length;
            }
        };
        capture.Start();
        Thread.Sleep(TimeSpan.FromSeconds(seconds));
        var elapsed = (DateTime.UtcNow - started).TotalSeconds;
        Console.Error.WriteLine($"{elapsed:0.00} 秒の間に {total} サンプル（{(double)total / Capture.TargetRate:0.00} 秒ぶん）");
        return 0;
    }
}
