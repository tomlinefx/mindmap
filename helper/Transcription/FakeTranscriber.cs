namespace Mindmap.Helper.Transcription;

/// <summary>
/// 偽の STT。音声のパイプライン（取得 → WebSocket → server）を通すための足場で、文字は作らない。
/// 音がある区間（RMS がしきい値以上）が続くと途中結果を、区間が途切れるか 5 秒を超えると確定結果を返す。本文は「（音声 a.b–c.d 秒）」。
/// 端末内 STT（sherpa-onnx）ができたら、この実装は差し替える。
/// </summary>
public sealed class FakeTranscriber : ITranscriber
{
    private const double Threshold = 0.01; // RMS。これ未満は無音
    private const double MaxSegment = 5.0;
    private const double SilenceToClose = 0.8;

    public string Label { get; set; } = "fake";
    public event Action<TranscriptionResult>? OnResult;

    private double? segmentStart;
    private double lastVoice;
    private double lastPartial;

    public void Push(float[] samples, double endSeconds)
    {
        double sum = 0;
        foreach (var s in samples) sum += s * s;
        var rms = Math.Sqrt(sum / Math.Max(samples.Length, 1));
        if (rms >= Threshold)
        {
            segmentStart ??= endSeconds - (double)samples.Length / 16_000;
            lastVoice = endSeconds;
            if (endSeconds - lastPartial >= 0.5)
            {
                lastPartial = endSeconds;
                OnResult?.Invoke(new TranscriptionResult(Text(segmentStart.Value, endSeconds), false, segmentStart.Value, endSeconds));
            }
            if (endSeconds - segmentStart.Value >= MaxSegment) Close(endSeconds);
        }
        else if (segmentStart is not null && endSeconds - lastVoice >= SilenceToClose)
        {
            Close(lastVoice);
        }
    }

    public void Finish()
    {
        if (segmentStart is not null) Close(lastVoice);
    }

    private void Close(double end)
    {
        var start = segmentStart!.Value;
        segmentStart = null;
        OnResult?.Invoke(new TranscriptionResult(Text(start, end), true, start, end));
    }

    private static string Text(double start, double end) => $"（音声 {start:0.0}–{end:0.0} 秒）";

    public void Dispose() { }
}
