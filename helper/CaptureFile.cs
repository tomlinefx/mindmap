using Mindmap.Helper.Audio;
using NAudio.Wave;

namespace Mindmap.Helper;

/// <summary>
/// 開発用 `capture-wav`: 取得を N 秒録って 16 kHz モノラルの wav に書く。取得とエコーキャンセルの確かめ用。
/// - self: マイク。other: 相手の音（会議アプリの id を渡せばそのプロセスの Process Loopback、渡さなければ再生デバイス全体の loopback）
/// - aec: 漏れを消したマイク（会議アプリの id が要る）。比較用に、消す前のマイクを `<out>.mic.wav`、参照にした相手の音を `<out>.ref.wav` にも書く
/// </summary>
public static class CaptureFile
{
    public static int Run(string track, int seconds, string path, string? app)
    {
        if (track is not ("self" or "other" or "aec")) { Console.Error.WriteLine("capture-wav self|other|aec <秒> <out.wav> [<app id>]"); return 2; }
        int? pid = null;
        if (track != "self" && app is not null)
        {
            pid = Apps.ResolvePid(app);
            if (pid is null) { Console.Error.WriteLine($"会議アプリ {app} は動いていません"); return 1; }
            Console.Error.WriteLine($"{app}（PID {pid}）の Process Loopback で取ります");
        }
        if (track == "aec" && pid is null) { Console.Error.WriteLine("aec には会議アプリの id が要ります"); return 2; }

        var self = track != "other" ? Capture.Microphone() : null;
        var other = track != "self" ? pid is int target ? Capture.ProcessLoopback(target) : Capture.Loopback() : null;
        var echo = track == "aec" ? new EchoCancellation() : null;

        var gate = new object();
        var writers = new List<(string file, WaveFileWriter writer, long total)>();
        Action<float[], double> WriteTo(string file)
        {
            var index = writers.Count;
            writers.Add((file, new WaveFileWriter(file, new WaveFormat(Capture.TargetRate, 16, 1)), 0));
            return (samples, _) =>
            {
                lock (gate)
                {
                    var entry = writers[index];
                    entry.writer.WriteSamples(samples, 0, samples.Length);
                    writers[index] = entry with { total = entry.total + samples.Length };
                }
            };
        }
        if (echo is not null)
        {
            self!.OnSamples += echo.PushSelf;
            other!.OnSamples += echo.PushReference;
            echo.OnSamples += WriteTo(path);
            self.OnSamples += WriteTo(Path.ChangeExtension(path, ".mic.wav"));
            other.OnSamples += WriteTo(Path.ChangeExtension(path, ".ref.wav"));
        }
        else (self ?? other)!.OnSamples += WriteTo(path);

        var started = DateTime.UtcNow;
        self?.Start();
        other?.Start();
        Thread.Sleep(TimeSpan.FromSeconds(seconds));
        var elapsed = (DateTime.UtcNow - started).TotalSeconds;
        // 取得を止めてから書き終える（止める前に writer を閉じると、遅れて届いたサンプルの書き込みで落ちる）
        self?.Dispose();
        other?.Dispose();
        echo?.Dispose();
        lock (gate)
        {
            foreach (var (file, writer, total) in writers)
            {
                writer.Dispose();
                Console.Error.WriteLine($"{Path.GetFileName(file)}: {elapsed:0.00} 秒の間に {total} サンプル（{(double)total / Capture.TargetRate:0.00} 秒ぶん）");
            }
        }
        return 0;
    }
}
