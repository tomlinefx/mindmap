using Mindmap.Helper.Audio;
using Mindmap.Helper.Transcription;
using NAudio.Wave;

namespace Mindmap.Helper;

/// <summary>開発用 `stt-file`: wav を 16 kHz モノラルにして STT に通し、途中結果・区切り・確定結果を、run と同じ形の JSON のイベントとして 1 行ずつ標準出力へ出す。</summary>
public static class SttFile
{
    public static int Run(string path, Func<ITranscriber> newTranscriber)
    {
        using var reader = new WaveFileReader(path);
        var resampler = new Resampler(reader.WaveFormat, Capture.TargetRate);
        using var stt = newTranscriber();
        var started = DateTime.UtcNow;
        stt.OnResult += result => Console.WriteLine(Events.Remark(Track.Self, result));
        stt.OnSegmentEnd += segment => Console.WriteLine(Events.SegmentEnd(Track.Self, segment.Start, segment.End));
        var buffer = new byte[reader.WaveFormat.AverageBytesPerSecond / 10];
        long samples = 0;
        int read;
        while ((read = reader.Read(buffer, 0, buffer.Length)) > 0)
        {
            var chunk = resampler.Convert(buffer, read);
            samples += chunk.Length;
            stt.Push(chunk, (double)samples / Capture.TargetRate);
        }
        stt.Finish();
        var audio = (double)samples / Capture.TargetRate;
        var elapsed = (DateTime.UtcNow - started).TotalSeconds;
        Console.Error.WriteLine($"音声 {audio:0.00} 秒、処理 {elapsed:0.00} 秒（RTF {elapsed / audio:0.000}）");
        return 0;
    }
}
