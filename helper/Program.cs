using Mindmap.Helper;
using Mindmap.Helper.Transcription;

// 引数の解釈と配線だけ。使い方は helper/README.md
//   mindmap-helper list
//   mindmap-helper check
//   mindmap-helper run --app <id> --port <n> [--origin <hostTime>] [--self-manual pause|take] [--vad-silence <秒>]
//   mindmap-helper stt-file <wav> [--vad-silence <秒>] [--transcript <out.json>]
static string? Option(string[] args, string name)
{
    var index = Array.IndexOf(args, name);
    return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
}

// server は標準出力・標準エラーを UTF-8 で読む（既定のコードページだと日本語が化ける）
Console.OutputEncoding = System.Text.Encoding.UTF8;

var command = args.Length > 0 ? args[0] : "";
switch (command)
{
    case "list":
        Console.WriteLine(Apps.ListJson());
        return 0;
    case "check":
        Console.WriteLine(Check.Json());
        return 0;
    case "run":
    {
        var app = Option(args, "--app");
        var port = Option(args, "--port");
        if (app is null || port is null || !int.TryParse(port, out var portNumber))
        {
            Console.Error.WriteLine("run には --app <id> と --port <n> が要ります");
            return 2;
        }
        var selfManual = Option(args, "--self-manual");
        if (selfManual is not (null or "pause" or "take"))
        {
            Console.Error.WriteLine("--self-manual は pause か take");
            return 2;
        }
        if (!TryVadSilence(args, out var minSilence)) return 2;
        using var cancel = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancel.Cancel(); };
        var newTranscriber = Transcriber(minSilence);
        if (newTranscriber is null) return 1;
        var session = new RunSession(portNumber, app, Option(args, "--origin"), selfManual, newTranscriber);
        return await session.Run(cancel.Token);
    }
    case "stt-file":
    {
        // 開発用: 16 kHz 以外でもよい wav を 1 本、端末内 STT に通して結果を標準出力に出す（モデルの確認用）
        var path = args.Length > 1 ? args[1] : null;
        if (path is null) { Console.Error.WriteLine("stt-file には wav のパスが要ります"); return 2; }
        if (!TryVadSilence(args, out var minSilence)) return 2;
        var newTranscriber = Transcriber(minSilence);
        if (newTranscriber is null) return 1;
        return SttFile.Run(path, newTranscriber, Option(args, "--transcript"));
    }
    case "capture-wav":
    {
        // 開発用: 取得とエコーキャンセルを確かめる。capture-wav self|other|aec <秒> <out.wav> [<app id>]
        if (args.Length < 4 || !int.TryParse(args[2], out var seconds)) { Console.Error.WriteLine("capture-wav self|other|aec <秒> <out.wav> [<app id>]"); return 2; }
        return CaptureFile.Run(args[1], seconds, args[3], args.Length > 4 ? args[4] : null);
    }
    default:
        Console.Error.WriteLine("使い方: mindmap-helper <list|check|run ...|stt-file <wav>|capture-wav ...>");
        return 2;
}

// 端末内 STT（sherpa-onnx）。MINDMAP_STT=fake なら偽の STT（音声のパイプラインの確認用）。モデルが無ければ null（理由は標準エラーに出す）
static Func<ITranscriber>? Transcriber(float? minSilence)
{
    if (Environment.GetEnvironmentVariable("MINDMAP_STT") == "fake") return () => minSilence is { } seconds ? new FakeTranscriber(seconds) : new FakeTranscriber();
    var files = ModelFiles.Find(Check.ModelDirectory);
    if (files is null)
    {
        Console.Error.WriteLine($"端末内 STT のモデルがありません: {Check.ModelDirectory}（scripts/win-stt-models.cmd で入れる）");
        return null;
    }
    return () => new SherpaTranscriber(files, minSilence: minSilence ?? 0.6f);
}

// --vad-silence <秒>: VAD が区間を閉じる無音の長さ。省略なら null（sherpa は 0.6、偽の STT は 0.8）。正の数でなければ理由を標準エラーに出して false
static bool TryVadSilence(string[] args, out float? minSilence)
{
    minSilence = null;
    if (Array.IndexOf(args, "--vad-silence") < 0) return true;
    var value = Option(args, "--vad-silence");
    if (value is not null && float.TryParse(value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var seconds) && float.IsFinite(seconds) && seconds > 0)
    {
        minSilence = seconds;
        return true;
    }
    Console.Error.WriteLine("--vad-silence は 0 より大きい秒数");
    return false;
}
