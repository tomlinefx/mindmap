using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
using NAudio.Wasapi.CoreAudioApi.Interfaces;
using NAudio.Wave;

namespace Mindmap.Helper.Audio;

/// <summary>
/// 会議アプリのプロセス（とその子プロセス）が出す音だけを取る、WASAPI の Process Loopback（Windows 10 2004 以降。ADR 0001）。
/// NAudio の WasapiLoopbackCapture は再生デバイス全体しか取れないので、ActivateAudioInterfaceAsync に
/// AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK を渡して IAudioClient を作り、読むところは NAudio の AudioClient に任せる。
/// Process Loopback は GetMixFormat を持たないので、形式はこちらで決める（48 kHz・16 bit・ステレオ。エンジンが変換する）。
/// 対象のプロセスが何も鳴らしていない間はサンプルが届かない（再生デバイスの loopback と同じ。Capture が無音で埋める）。
/// </summary>
public sealed class ProcessLoopbackCapture : IWaveIn
{
    private const string ProcessLoopbackDevice = "VAD\\Process_Loopback"; // VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
    private const int ActivationTypeProcessLoopback = 1; // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
    private const int IncludeTargetProcessTree = 0; // PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
    private const ushort VtBlob = 65; // PROPVARIANT の vt
    private const long BufferDuration = 200_000; // 100 ns 単位（20 ms）。Microsoft の ApplicationLoopback の例と同じ
    private static readonly Guid IidIAudioClient = new("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    private static readonly TimeSpan ActivationTimeout = TimeSpan.FromSeconds(5);

    private readonly AudioClient client;
    private readonly AudioCaptureClient captureClient;
    private readonly AutoResetEvent ready = new(false);
    private Thread? thread;
    private volatile bool stopping;

    public WaveFormat WaveFormat { get; set; } = new WaveFormat(48_000, 16, 2);

    public event EventHandler<WaveInEventArgs>? DataAvailable;
    public event EventHandler<StoppedEventArgs>? RecordingStopped;

    public ProcessLoopbackCapture(int pid)
    {
        client = new AudioClient(Activate(pid));
        client.Initialize(AudioClientShareMode.Shared, AudioClientStreamFlags.Loopback | AudioClientStreamFlags.EventCallback, BufferDuration, 0, WaveFormat, Guid.Empty);
        client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
        captureClient = client.AudioCaptureClient;
    }

    public void StartRecording()
    {
        if (thread is not null) throw new InvalidOperationException("もう取得しています");
        thread = new Thread(Loop) { IsBackground = true, Name = "process-loopback" };
        client.Start();
        thread.Start();
    }

    public void StopRecording()
    {
        if (thread is null) throw new InvalidOperationException("取得していません");
        stopping = true;
        ready.Set();
        thread.Join();
        thread = null;
        client.Stop();
    }

    // 対象の PID の Process Loopback の IAudioClient を作る。完了は別のスレッドに届くので Task で待つ
    private static IAudioClient Activate(int pid)
    {
        var parameters = new ActivationParams { ActivationType = ActivationTypeProcessLoopback, TargetProcessId = pid, ProcessLoopbackMode = IncludeTargetProcessTree };
        var parametersPtr = Marshal.AllocHGlobal(Marshal.SizeOf<ActivationParams>());
        var variantPtr = Marshal.AllocHGlobal(Marshal.SizeOf<PropVariantBlob>());
        try
        {
            Marshal.StructureToPtr(parameters, parametersPtr, false);
            Marshal.StructureToPtr(new PropVariantBlob { vt = VtBlob, cbSize = (uint)Marshal.SizeOf<ActivationParams>(), pBlobData = parametersPtr }, variantPtr, false);
            var handler = new CompletionHandler();
            ActivateAudioInterfaceAsync(ProcessLoopbackDevice, IidIAudioClient, variantPtr, handler, out _);
            if (!handler.Result.Task.Wait(ActivationTimeout)) throw new InvalidOperationException($"Process Loopback（PID {pid}）の起動が {ActivationTimeout.TotalSeconds} 秒で終わりません");
            return handler.Result.Task.GetAwaiter().GetResult();
        }
        finally
        {
            Marshal.FreeHGlobal(variantPtr);
            Marshal.FreeHGlobal(parametersPtr);
        }
    }

    // イベントで起きて、届いたパケットを全部読んで DataAvailable へ渡す。SILENT の印が付いたパケットは無音にする
    private void Loop()
    {
        var frameBytes = WaveFormat.BlockAlign;
        try
        {
            while (!stopping)
            {
                ready.WaitOne();
                while (!stopping && captureClient.GetNextPacketSize() > 0)
                {
                    var pointer = captureClient.GetBuffer(out var frames, out var flags);
                    var bytes = frames * frameBytes;
                    var buffer = new byte[bytes];
                    if ((flags & AudioClientBufferFlags.Silent) == 0) Marshal.Copy(pointer, buffer, 0, bytes);
                    captureClient.ReleaseBuffer(frames);
                    DataAvailable?.Invoke(this, new WaveInEventArgs(buffer, bytes));
                }
            }
            RecordingStopped?.Invoke(this, new StoppedEventArgs());
        }
        catch (Exception e)
        {
            RecordingStopped?.Invoke(this, new StoppedEventArgs(e));
        }
    }

    public void Dispose()
    {
        if (thread is not null) StopRecording();
        captureClient.Dispose();
        client.Dispose();
        ready.Dispose();
    }

    // AUDIOCLIENT_ACTIVATION_PARAMS（ActivationType と、union の AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS）
    [StructLayout(LayoutKind.Sequential)]
    private struct ActivationParams
    {
        public int ActivationType;
        public int TargetProcessId;
        public int ProcessLoopbackMode;
    }

    // PROPVARIANT の VT_BLOB の形（vt と予約の 3 WORD、BLOB { cbSize; pBlobData }）
    [StructLayout(LayoutKind.Sequential)]
    private struct PropVariantBlob
    {
        public ushort vt;
        public ushort reserved1;
        public ushort reserved2;
        public ushort reserved3;
        public uint cbSize;
        public IntPtr pBlobData;
    }

    private sealed class CompletionHandler : IActivateAudioInterfaceCompletionHandler
    {
        public readonly TaskCompletionSource<IAudioClient> Result = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            try
            {
                operation.GetActivateResult(out var hr, out var activated);
                if (hr < 0) Result.TrySetException(Marshal.GetExceptionForHR(hr) ?? new COMException("Process Loopback を起動できません", hr));
                else Result.TrySetResult((IAudioClient)activated);
            }
            catch (Exception e)
            {
                Result.TrySetException(e);
            }
        }
    }

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    private static extern void ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        in Guid riid,
        IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation activationOperation);
}
