using Mindmap.Helper;
using Mindmap.Helper.Transcription;

// 引数の解釈と配線だけ。使い方は helper/README.md
//   mindmap-helper list
//   mindmap-helper check
//   mindmap-helper run --app <id> --port <n> [--origin <hostTime>] [--self-manual pause|take]
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
        using var cancel = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancel.Cancel(); };
        var newTranscriber = Transcriber();
        if (newTranscriber is null) return 1;
        var session = new RunSession(portNumber, app, Option(args, "--origin"), selfManual, newTranscriber);
        return await session.Run(cancel.Token);
    }
    case "stt-file":
    {
        // 開発用: 16 kHz 以外でもよい wav を 1 本、端末内 STT に通して結果を標準出力に出す（モデルの確認用）
        var path = args.Length > 1 ? args[1] : null;
        if (path is null) { Console.Error.WriteLine("stt-file には wav のパスが要ります"); return 2; }
        var newTranscriber = Transcriber();
        if (newTranscriber is null) return 1;
        return SttFile.Run(path, newTranscriber);
    }
    case "capture-wav":
    {
        // 開発用: 取得を確かめる。capture-wav self|other <秒> <out.wav>
        if (args.Length < 4 || !int.TryParse(args[2], out var seconds)) { Console.Error.WriteLine("capture-wav self|other <秒> <out.wav>"); return 2; }
        return CaptureFile.Run(args[1], seconds, args[3]);
    }
    default:
        Console.Error.WriteLine("使い方: mindmap-helper <list|check|run ...|stt-file <wav>|capture-wav ...>");
        return 2;
}

// 端末内 STT（sherpa-onnx）。MINDMAP_STT=fake なら偽の STT（音声のパイプラインの確認用）。モデルが無ければ null（理由は標準エラーに出す）
static Func<ITranscriber>? Transcriber()
{
    if (Environment.GetEnvironmentVariable("MINDMAP_STT") == "fake") return () => new FakeTranscriber();
    var files = ModelFiles.Find(Check.ModelDirectory);
    if (files is null)
    {
        Console.Error.WriteLine($"端末内 STT のモデルがありません: {Check.ModelDirectory}（scripts/win-stt-models.cmd で入れる）");
        return null;
    }
    return () => new SherpaTranscriber(files);
}
