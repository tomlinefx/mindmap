using Mindmap.Helper.Audio;
using Mindmap.Helper.Transcription;
using System.Text.Json;
using NAudio.Wave;

namespace Mindmap.Helper;

/// <summary>開発用 `stt-file`: wav を 16 kHz モノラルにして STT に通し、途中結果・区切り・確定結果を、run と同じ形の JSON のイベントとして 1 行ずつ標準出力へ出す。
/// transcriptPath があれば、確定結果だけを `cli play` が読む文字起こしの JSON（server/src/core/transcript.ts の TranscriptFile）でも書く。track は play が 自分 として読む "microphone"。</summary>
public static class SttFile
{
    public static int Run(string path, Func<ITranscriber> newTranscriber, string? transcriptPath = null)
    {
        using var reader = new WaveFileReader(path);
        var resampler = new Resampler(reader.WaveFormat, Capture.TargetRate);
        using var stt = newTranscriber();
        var started = DateTime.UtcNow;
        var segments = new List<object>();
        stt.OnResult += result =>
        {
            Console.WriteLine(Events.Remark(Track.Self, result));
            if (result.IsFinal && result.Text.Trim().Length > 0)
                segments.Add(new { track = "microphone", start_seconds = result.Start, end_seconds = result.End, text = result.Text });
        };
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
        return transcriptPath is null ? 0 : WriteTranscript(transcriptPath, segments);
    }

    private static int WriteTranscript(string path, List<object> segments)
    {
        try
        {
            var options = new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
            File.WriteAllText(path, JsonSerializer.Serialize(new { transcript = new { segments } }, options));
            return 0;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine($"文字起こしを書けません: {path}（{e.Message}）");
            return 1;
        }
    }
}
