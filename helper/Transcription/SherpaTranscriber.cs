using System.Threading.Channels;
using SherpaOnnx;

namespace Mindmap.Helper.Transcription;

/// <summary>
/// 端末内 STT（ADR 0001）。sherpa-onnx の日本語 zipformer（ReazonSpeech、非ストリーミング）に、silero VAD で切った区間を渡す。
/// 日本語のストリーミングモデルは sherpa-onnx に無いので、途中結果は「話している最中の区間をここまでで 0.5 秒ごとにデコードし直す」ことで作る
/// （server は途中結果が音声の時刻で 1 秒更新されないと発言にするので、1 秒より短い間隔で出し続ける。server/src/core/settle.ts）。
/// 確定結果は VAD が区間を閉じたときに、その区間全体をデコードして出す。start は途中結果と同じ値にする（server は track と start で同じ発話と見る）。
/// wordTimes はトークンの時刻から作る。
/// デコードは音声の取得のスレッドを止めないよう、1 本の作業スレッドで順に行う。
/// </summary>
public sealed class SherpaTranscriber : ITranscriber
{
    private const int SampleRate = 16_000;
    private const int Window = 512; // silero VAD の 1 窓（16 kHz で 32 ms）
    private const double PartialEvery = 0.5; // 途中結果を出し直す間隔（音声の秒）。server の 1 秒より短く
    private const double MinPartial = 0.6; // これより短い区間は途中結果を出さない
    private const double LeadIn = 0.5; // デコードする区間の頭に足す無音（秒）。語の途中から始まる音声は、無音が無いと頭の数秒を落とす
    private const double PreRoll = 0.4; // VAD が話し始めと判定するより前の音声を、デコードする区間の頭に足す（頭の子音を落とさない）
    private const int HistorySeconds = 20;
    private const float MaxSpeech = 12f; // VAD が区間を強制的に閉じる長さ（秒）。発言は 1 文のつもり。長いほど途中結果のデコードし直しが重い

    public event Action<TranscriptionResult>? OnResult;

    private readonly OfflineRecognizer recognizer;
    private readonly VoiceActivityDetector vad;
    private readonly Channel<float[]?> queue = Channel.CreateUnbounded<float[]?>();
    private readonly string? dump = Environment.GetEnvironmentVariable("MINDMAP_STT_DUMP"); // 開発用: デコードした区間の音声を wav で残すフォルダ
    private int dumped;
    private readonly Task worker;

    private readonly List<float> pending = []; // VAD の窓に満たない端数
    private readonly List<float> history = []; // 直近の音声（先行音声と途中結果の区間はここから切り出す）
    private long historyStart; // history[0] のサンプル番号（トラックの頭から数える）
    private long fed; // VAD へ渡したサンプルの数（トラック内の時刻の基準）
    private bool inSpeech;
    private long speechStart; // 話し始めのサンプル番号（先行音声を含む）
    private double lastPartial;
    private double lastSpeechAt; // VAD が話していると判定した最後の時刻（秒）
    private double? partialStart; // この区間で途中結果に使った start（確定結果も同じ start で出す）

    public string Label { get => label; set => label = value; }
    private string label;

    public SherpaTranscriber(ModelFiles files, string label = "stt", int threads = 4)
    {
        this.label = label;
        var config = new OfflineRecognizerConfig();
        config.ModelConfig.Transducer.Encoder = files.Encoder;
        config.ModelConfig.Transducer.Decoder = files.Decoder;
        config.ModelConfig.Transducer.Joiner = files.Joiner;
        config.ModelConfig.Tokens = files.Tokens;
        config.ModelConfig.NumThreads = threads;
        config.DecodingMethod = "greedy_search";
        recognizer = new OfflineRecognizer(config);

        var vadConfig = new VadModelConfig();
        vadConfig.SileroVad.Model = files.Vad;
        vadConfig.SileroVad.Threshold = 0.3f; // 再生デバイス経由の小さい音でも話し始めを落とさない
        vadConfig.SileroVad.MinSilenceDuration = 0.6f;
        vadConfig.SileroVad.MinSpeechDuration = 0.25f;
        vadConfig.SileroVad.MaxSpeechDuration = MaxSpeech;
        vadConfig.SileroVad.WindowSize = Window;
        vad = new VoiceActivityDetector(vadConfig, 60);

        worker = Task.Run(Work);
    }

    public void Push(float[] samples, double endSeconds) => queue.Writer.TryWrite(samples);

    public void Finish()
    {
        queue.Writer.TryWrite(null);
        queue.Writer.TryComplete();
        try { worker.Wait(TimeSpan.FromSeconds(30)); } catch (AggregateException) { }
    }

    private async Task Work()
    {
        await foreach (var samples in queue.Reader.ReadAllAsync())
        {
            if (samples is null)
            {
                vad.Flush();
                Drain();
                return;
            }
            pending.AddRange(samples);
            while (pending.Count >= Window)
            {
                var window = pending.GetRange(0, Window).ToArray();
                pending.RemoveRange(0, Window);
                vad.AcceptWaveform(window);
                fed += Window;
                history.AddRange(window);
                var overflow = history.Count - HistorySeconds * SampleRate;
                if (overflow > 0)
                {
                    history.RemoveRange(0, overflow);
                    historyStart += overflow;
                }
                FollowSpeech();
                Drain();
            }
        }
    }

    private double Now => (double)fed / SampleRate;

    /// <summary>history から [from, to) のサンプルを切り出す（from はトラックの頭からのサンプル番号。history より前は無視）。</summary>
    private float[] Slice(long from, long to)
    {
        var begin = (int)Math.Max(0, from - historyStart);
        var end = (int)Math.Min(history.Count, to - historyStart);
        return end <= begin ? [] : history.GetRange(begin, end - begin).ToArray();
    }

    /// <summary>
    /// 話している最中の区間を、0.5 秒ごとにデコードし直して途中結果にする。
    /// VAD の IsSpeechDetected は話の途中の短い無音でも false になるので、区間の始まりは VAD が区間を閉じる（Drain）か、1 秒以上話さないときだけ捨てる。
    /// </summary>
    private void FollowSpeech()
    {
        if (!vad.IsSpeechDetected())
        {
            if (inSpeech && Now - lastSpeechAt > 1.0) inSpeech = false;
            return;
        }
        lastSpeechAt = Now;
        if (!inSpeech)
        {
            inSpeech = true;
            // VAD が話し始めと判定するまでの遅れ（MinSpeechDuration と 1 窓）と、先行音声のぶんを戻す
            speechStart = Math.Max(0, fed - (long)((0.25 + PreRoll) * SampleRate) - Window);
            lastPartial = Now;
            partialStart = null;
        }
        var start = (double)speechStart / SampleRate;
        if (Now - lastPartial < PartialEvery || Now - start < MinPartial) return;
        lastPartial = Now;
        var result = Decode(Slice(speechStart, fed), start);
        if (result is null) return;
        partialStart = start;
        OnResult?.Invoke(result with { IsFinal = false, End = Now, WordTimes = null });
    }

    /// <summary>VAD が閉じた区間を確定結果にする。</summary>
    private void Drain()
    {
        while (!vad.IsEmpty())
        {
            var segment = vad.Front();
            vad.Pop();
            inSpeech = false;
            // 区間の頭に先行音声を足す（history に残っているぶんだけ）
            var preRoll = Slice(segment.Start - (long)(PreRoll * SampleRate), segment.Start);
            var start = (double)(segment.Start - preRoll.Length) / SampleRate;
            var result = Decode([.. preRoll, .. segment.Samples], start);
            // 途中結果を出した区間なら、その start に揃える（server が同じ発話として確定結果で置き換えられるように）
            var aligned = partialStart is { } ps && Math.Abs(ps - start) < 1.0 ? ps : start;
            partialStart = null;
            if (result is not null) OnResult?.Invoke(result with { IsFinal = true, Start = aligned, WordTimes = result.WordTimes?.Select(w => w with { start = w.start - start + aligned, end = w.end - start + aligned }).ToList() });
        }
    }

    /// <summary>区間をデコードする。文字が無ければ null。start は区間の始まりのトラック内時刻。頭に LeadIn の無音を足して渡す。</summary>
    private TranscriptionResult? Decode(float[] audio, double start)
    {
        var samples = new float[(int)(LeadIn * SampleRate) + audio.Length];
        audio.CopyTo(samples, (int)(LeadIn * SampleRate));
        if (dump is not null)
        {
            Directory.CreateDirectory(dump);
            using var writer = new NAudio.Wave.WaveFileWriter(Path.Combine(dump, $"{label}-{++dumped:0000}-{start:0.00}.wav"), new NAudio.Wave.WaveFormat(SampleRate, 16, 1));
            writer.WriteSamples(samples, 0, samples.Length);
        }
        using var stream = recognizer.CreateStream();
        stream.AcceptWaveform(SampleRate, samples);
        recognizer.Decode(stream);
        var result = stream.Result;
        var text = result.Text.Trim();
        if (text.Length == 0) return null;
        var end = start + (double)audio.Length / SampleRate;
        return new TranscriptionResult(text, true, start, end, WordTimes(result, start - LeadIn, end));
    }

    /// <summary>トークンの時刻から wordTimes（本文の UTF-16 の位置と秒）を作る。本文の中でトークンの表記が続いて見つかる限り付ける。</summary>
    private static IReadOnlyList<WordTime> WordTimes(OfflineRecognizerResult result, double start, double end)
    {
        if (result.Timestamps is null || result.Tokens is null) return [];
        var text = result.Text;
        var times = new List<WordTime>();
        var location = 0;
        for (var i = 0; i < result.Tokens.Length && i < result.Timestamps.Length; i++)
        {
            var token = result.Tokens[i].Replace("▁", " ");
            var index = text.IndexOf(token, location, StringComparison.Ordinal);
            if (token.Trim().Length == 0 || index < 0) continue;
            var tokenStart = Math.Max(start + LeadIn, start + result.Timestamps[i]);
            var tokenEnd = i + 1 < result.Timestamps.Length ? start + result.Timestamps[i + 1] : end;
            times.Add(new WordTime(index, token.Length, tokenStart, Math.Max(tokenStart, tokenEnd)));
            location = index + token.Length;
        }
        return times;
    }

    public void Dispose()
    {
        queue.Writer.TryComplete();
        vad.Dispose();
        recognizer.Dispose();
    }
}

/// <summary>モデルの置き場（Check.ModelDirectory）にあるファイル。int8 の版があればそれを使う。</summary>
public sealed record ModelFiles(string Encoder, string Decoder, string Joiner, string Tokens, string Vad)
{
    public static ModelFiles? Find(string directory)
    {
        if (!Directory.Exists(directory)) return null;
        string? Pick(string prefix)
        {
            var candidates = Directory.EnumerateFiles(directory, $"{prefix}*.onnx").OrderByDescending(f => f.Contains(".int8.")).ToList();
            return candidates.FirstOrDefault();
        }
        var encoder = Pick("encoder");
        var decoder = Pick("decoder");
        var joiner = Pick("joiner");
        var tokens = Path.Combine(directory, "tokens.txt");
        var vad = Path.Combine(directory, "silero_vad.onnx");
        if (encoder is null || decoder is null || joiner is null || !File.Exists(tokens) || !File.Exists(vad)) return null;
        return new ModelFiles(encoder, decoder, joiner, tokens, vad);
    }
}
