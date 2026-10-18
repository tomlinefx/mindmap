using System.Diagnostics;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Mindmap.Helper.Audio;

/// <summary>
/// 1 トラック分の音声取得。WASAPI の形式（たいてい 48 kHz・float・ステレオ）を 16 kHz・モノラルの float にして OnSamples へ渡す。
/// 自分: マイク（WasapiCapture）。相手: 会議アプリの音。
/// TODO(ADR 0001): 相手は Process Loopback（会議アプリのプロセスだけ）にする。いまは既定の再生デバイス全体の loopback（通知音なども混ざる）。
/// </summary>
public sealed class Capture : IDisposable
{
    public const int TargetRate = 16_000;

    private readonly WasapiCapture capture;
    private readonly Resampler resampler;
    private readonly object gate = new();
    private bool paused;
    private long samplesOut; // 16 kHz で数えた、渡したサンプルの数（休止中も時刻は進めるので、無音を渡す）
    private readonly Stopwatch clock = new(); // 取得を始めてからの実時間。loopback は何も鳴っていない間サンプルが届かないので、その穴を無音で埋めて時刻を実時間に合わせる
    private const double GapToFill = 0.1; // この秒数より長い穴だけ埋める

    /// <summary>16 kHz モノラルのサンプルと、その区間の終わりのトラック内時刻（秒）。</summary>
    public event Action<float[], double>? OnSamples;

    /// <summary>取得が予期せず止まった（機器が外れた等）。</summary>
    public event Action<Exception?>? OnStopped;

    private Capture(WasapiCapture capture)
    {
        this.capture = capture;
        resampler = new Resampler(capture.WaveFormat, TargetRate);
        capture.DataAvailable += (_, e) => Push(e.Buffer, e.BytesRecorded);
        capture.RecordingStopped += (_, e) => OnStopped?.Invoke(e.Exception);
    }

    public static Capture Microphone() => new(new WasapiCapture());

    public static Capture Loopback() => new(new WasapiLoopbackCapture());

    public void Start()
    {
        clock.Start();
        capture.StartRecording();
    }

    /// <summary>休止: 取った音の代わりに無音を渡す（時刻は進める）。</summary>
    public bool Paused
    {
        get { lock (gate) return paused; }
        set { lock (gate) paused = value; }
    }

    private void Push(byte[] buffer, int bytes)
    {
        var samples = resampler.Convert(buffer, bytes);
        if (samples.Length == 0) return;
        if (Paused) Array.Clear(samples);
        // 実時間に対して届いたサンプルが足りない（何も鳴っていなかった）ぶんは、無音を先に渡す
        var expected = (long)(clock.Elapsed.TotalSeconds * TargetRate);
        var gap = expected - samplesOut - samples.Length;
        if (gap > GapToFill * TargetRate)
        {
            var silence = new float[gap];
            samplesOut += silence.Length;
            OnSamples?.Invoke(silence, (double)samplesOut / TargetRate);
        }
        samplesOut += samples.Length;
        OnSamples?.Invoke(samples, (double)samplesOut / TargetRate);
    }

    public void Dispose()
    {
        try { capture.StopRecording(); } catch (InvalidOperationException) { }
        capture.Dispose();
    }
}

/// <summary>WASAPI のバッファ（PCM 16 bit か IEEE float、任意のチャンネル数）を、16 kHz モノラルの float にする。線形補間の簡単な版。</summary>
public sealed class Resampler
{
    // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
    private static readonly Guid IeeeFloatSubtype = new("00000003-0000-0010-8000-00aa00389b71");
    private readonly WaveFormat source;
    private readonly double ratio;
    private double position; // 入力のサンプル位置（モノラル化した後）。小数部が次の出力の位相
    private float last; // 直前の入力サンプル（バッファの境目をまたぐ補間に使う）

    public Resampler(WaveFormat source, int targetRate)
    {
        this.source = source;
        ratio = (double)source.SampleRate / targetRate;
    }

    public float[] Convert(byte[] buffer, int bytes)
    {
        var mono = ToMono(buffer, bytes);
        if (mono.Length == 0) return [];
        var output = new List<float>((int)(mono.Length / ratio) + 2);
        // position は、前のバッファの最後のサンプル（last）を 0 とした入力の位置
        while (position < mono.Length)
        {
            var index = (int)Math.Floor(position);
            var fraction = (float)(position - index);
            var a = index == 0 ? last : mono[index - 1];
            var b = mono[index];
            output.Add(a + (b - a) * fraction);
            position += ratio;
        }
        position -= mono.Length;
        last = mono[^1];
        return output.ToArray();
    }

    private float[] ToMono(byte[] buffer, int bytes)
    {
        var channels = source.Channels;
        var bytesPerSample = source.BitsPerSample / 8;
        var frames = bytes / (bytesPerSample * channels);
        var mono = new float[frames];
        var isFloat = source.Encoding == WaveFormatEncoding.IeeeFloat || (source is WaveFormatExtensible ext && ext.SubFormat == IeeeFloatSubtype);
        for (var frame = 0; frame < frames; frame++)
        {
            float sum = 0;
            for (var channel = 0; channel < channels; channel++)
            {
                var offset = (frame * channels + channel) * bytesPerSample;
                sum += isFloat
                    ? BitConverter.ToSingle(buffer, offset)
                    : bytesPerSample == 2 ? BitConverter.ToInt16(buffer, offset) / 32768f : BitConverter.ToInt32(buffer, offset) / 2147483648f;
            }
            mono[frame] = sum / channels;
        }
        return mono;
    }
}
