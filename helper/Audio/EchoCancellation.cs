using System.Runtime.InteropServices;

namespace Mindmap.Helper.Audio;

/// <summary>
/// スピーカーに出た相手の声がマイクに漏れたぶんを、自分のトラックから消す（WebRTC AEC3 + high-pass filter。ADR 0001）。
/// 2 つの Capture はそれぞれ実時間に合わせた 16 kHz のサンプル列を出すので、サンプル位置をそのまま時刻として合わせる
/// （2 つの Capture の開始のずれと機器の遅れは数十 ms の一定の差で、AEC3 の遅延推定が吸収する）。
/// 相手の音は時刻つきのリングバッファに置き、自分の音は Latency ぶん遅らせて（その時刻の参照が届くのを待って）、
/// 10 ms（160 サンプル）ごとに reverse（参照）→ capture（マイク）の順で AEC3 に渡す。参照が無い時刻は無音。
/// 上流の EchoCanceller.swift は 48 kHz で動かすが、ここは STT と同じ 16 kHz で動かす（AEC3 は 16 kHz を受ける。変換が 1 回減る）。
/// </summary>
public sealed class EchoCancellation : IDisposable
{
    public const int FrameSamples = Capture.TargetRate / 100; // 10 ms
    private const double Latency = 0.15; // 自分の音を遅らせる秒数。相手の Capture は 0.1 秒までの穴を埋めずに遅れて届くので、それより長く
    private const int ReferenceSeconds = 4;
    private const float EpStrengthDefaultGain = 0.01f; // 上流の production（既定の 1 だと、漏れの無い条件で開始直後の発話を削る）

    private readonly Apm apm;
    private readonly object gate = new();
    private readonly float[] reference = new float[Capture.TargetRate * ReferenceSeconds]; // 相手のサンプル位置 % 長さ の場所に置く
    private long referenceEnd; // 相手の、書いた末尾のサンプル位置
    private readonly List<float> pending = new(); // 自分の未処理のサンプル
    private long pendingStart; // pending[0] の自分のサンプル位置
    private readonly float[] reverseFrame = new float[FrameSamples];
    private readonly float[] captureFrame = new float[FrameSamples];

    /// <summary>漏れを消した自分の音（16 kHz モノラル）と、その区間の終わりのトラック内時刻（秒）。Capture.OnSamples と同じ形。</summary>
    public event Action<float[], double>? OnSamples;

    /// <summary>webrtc-apm.dll が無ければ DllNotFoundException、AEC3 を作れなければ InvalidOperationException。</summary>
    public EchoCancellation() => apm = new Apm(Capture.TargetRate, EpStrengthDefaultGain);

    /// <summary>相手の音（スピーカーに出た参照）。Capture.OnSamples から。</summary>
    public void PushReference(float[] samples, double end)
    {
        lock (gate)
        {
            var endPosition = (long)Math.Round(end * Capture.TargetRate);
            var start = endPosition - samples.Length;
            // 前回の末尾との穴（0.1 秒未満。Capture が埋めない）は無音にして、古い周回の音を参照にしない
            for (var position = referenceEnd; position < start; position++) reference[position % reference.Length] = 0f;
            for (var i = 0; i < samples.Length; i++) reference[(start + i) % reference.Length] = samples[i];
            referenceEnd = Math.Max(referenceEnd, endPosition);
        }
    }

    /// <summary>自分の音（マイク）。Capture.OnSamples から。Latency より古いぶんを処理して OnSamples に出す。</summary>
    public void PushSelf(float[] samples, double end)
    {
        lock (gate)
        {
            var endPosition = (long)Math.Round(end * Capture.TargetRate);
            if (pending.Count == 0) pendingStart = endPosition - samples.Length;
            pending.AddRange(samples);
            var keep = (int)(Latency * Capture.TargetRate);
            while (pending.Count - keep >= FrameSamples)
            {
                pending.CopyTo(0, captureFrame, 0, FrameSamples);
                pending.RemoveRange(0, FrameSamples);
                for (var i = 0; i < FrameSamples; i++)
                {
                    var position = pendingStart + i;
                    var written = position < referenceEnd && position >= referenceEnd - reference.Length;
                    reverseFrame[i] = written ? reference[position % reference.Length] : 0f;
                }
                apm.ProcessReverse(reverseFrame);
                apm.ProcessCapture(captureFrame);
                pendingStart += FrameSamples;
                OnSamples?.Invoke((float[])captureFrame.Clone(), (double)pendingStart / Capture.TargetRate);
            }
        }
    }

    public void Dispose() => apm.Dispose();

    /// <summary>webrtc-apm.dll（helper/native/webrtc-apm。scripts/win-webrtc-apm.cmd が作る）の P/Invoke。</summary>
    private sealed class Apm : IDisposable
    {
        private const string Library = "webrtc-apm";
        private IntPtr handle;

        public Apm(int sampleRate, float epStrengthDefaultGain)
        {
            var settings = new Settings { ep_strength_default_gain = epStrengthDefaultGain };
            handle = apm_create(sampleRate, 1, in settings);
            if (handle == IntPtr.Zero) throw new InvalidOperationException("WebRTC AEC3 を初期化できません");
        }

        public void ProcessReverse(float[] frame)
        {
            var status = apm_process_reverse(handle, frame, frame.Length);
            if (status != 0) throw new InvalidOperationException($"apm_process_reverse が失敗しました: {status}");
        }

        public void ProcessCapture(float[] frame)
        {
            var status = apm_process_capture(handle, frame, frame.Length);
            if (status != 0) throw new InvalidOperationException($"apm_process_capture が失敗しました: {status}");
        }

        public void Dispose()
        {
            if (handle == IntPtr.Zero) return;
            apm_destroy(handle);
            handle = IntPtr.Zero;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct Settings
        {
            public float ep_strength_default_gain;
        }

        [DllImport(Library, ExactSpelling = true)]
        private static extern IntPtr apm_create(int sample_rate, int channels, in Settings settings);

        [DllImport(Library, ExactSpelling = true)]
        private static extern int apm_process_reverse(IntPtr handle, float[] frame, int frames);

        [DllImport(Library, ExactSpelling = true)]
        private static extern int apm_process_capture(IntPtr handle, [In, Out] float[] frame, int frames);

        [DllImport(Library, ExactSpelling = true)]
        private static extern void apm_destroy(IntPtr handle);
    }
}
