namespace Mindmap.Helper.Transcription;

/// <summary>
/// 端末内 STT / クラウド STT の差し口（ADR 0001）。16 kHz モノラルの音声を受け取り、途中結果（IsFinal=false）と確定結果（IsFinal=true）を OnResult で返す。
/// start / end はトラック内の秒（0 = 取得の開始）で、原点への変換は呼び出し側が行う。
/// </summary>
public interface ITranscriber : IDisposable
{
    /// <summary>どのトラックの STT か（開発用の記録の名前）。</summary>
    string Label { get; set; }

    event Action<TranscriptionResult>? OnResult;

    /// <summary>VAD が区間を閉じた。その区間の確定結果（OnResult）より先に、デコードを待たずに呼ばれる。確定結果が空の区間でも呼ばれる。</summary>
    event Action<SegmentEnd>? OnSegmentEnd;

    /// <summary>samples はその区間の音、endSeconds はその区間の終わりのトラック内時刻。</summary>
    void Push(float[] samples, double endSeconds);

    /// <summary>取得の終わり。溜めている分を確定して返す。</summary>
    void Finish();
}

/// <summary>区間の終わり。Start は同じ区間の確定結果の Start と同じ揃え方、End は区間の終わり。どちらもトラック内の秒。</summary>
public sealed record SegmentEnd(double Start, double End);
