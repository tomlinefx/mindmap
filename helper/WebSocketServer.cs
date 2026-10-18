using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace Mindmap.Helper;

/// <summary>
/// 127.0.0.1 の 1 ポートで 1 つの接続（server）を受ける WebSocket。イベントは Send で積み、届いた順に 1 本の送信で流す。
/// server からの指示は OnInstruction で受ける（token が合うものだけ）。
/// </summary>
public sealed class WebSocketServer : IAsyncDisposable
{
    private readonly HttpListener listener = new();
    private readonly Channel<string> outgoing = Channel.CreateUnbounded<string>();
    private readonly string? controlToken;
    private readonly Action<Instruction> onInstruction;
    private readonly CancellationTokenSource stopping = new();
    private readonly string? trace = Environment.GetEnvironmentVariable("MINDMAP_HELPER_TRACE"); // 開発用: 送ったイベントを 1 行ずつ追記する
    private Task? loop;

    public WebSocketServer(int port, string? controlToken, Action<Instruction> onInstruction)
    {
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        this.controlToken = controlToken;
        this.onInstruction = onInstruction;
    }

    public void Start()
    {
        listener.Start();
        loop = Task.Run(Serve);
    }

    /// <summary>接続がまだ無くても積んでおき、接続したら順に送る。</summary>
    public void Send(string json)
    {
        if (trace is not null) File.AppendAllText(trace, json + "\n");
        outgoing.Writer.TryWrite(json);
    }

    private async Task Serve()
    {
        try
        {
            var context = await listener.GetContextAsync().WaitAsync(stopping.Token);
            if (!context.Request.IsWebSocketRequest)
            {
                context.Response.StatusCode = 400;
                context.Response.Close();
                return;
            }
            var socket = (await context.AcceptWebSocketAsync(null)).WebSocket;
            var sending = SendLoop(socket);
            var receiving = ReceiveLoop(socket);
            await Task.WhenAny(sending, receiving);
            stopping.Cancel();
        }
        catch (OperationCanceledException) { }
        catch (HttpListenerException) { }
    }

    private async Task SendLoop(WebSocket socket)
    {
        await foreach (var json in outgoing.Reader.ReadAllAsync(stopping.Token))
        {
            await socket.SendAsync(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text, true, stopping.Token);
        }
    }

    private async Task ReceiveLoop(WebSocket socket)
    {
        var buffer = new byte[64 * 1024];
        while (socket.State == WebSocketState.Open)
        {
            var text = new StringBuilder();
            WebSocketReceiveResult result;
            do
            {
                result = await socket.ReceiveAsync(buffer, stopping.Token);
                if (result.MessageType == WebSocketMessageType.Close) return;
                text.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
            } while (!result.EndOfMessage);
            Handle(text.ToString());
        }
    }

    private void Handle(string text)
    {
        Instruction? instruction;
        try
        {
            instruction = JsonSerializer.Deserialize<Instruction>(text);
        }
        catch (JsonException)
        {
            Console.Error.WriteLine($"指示を読めません: {text}");
            return;
        }
        if (instruction is null) return;
        // 合言葉が合わない指示は無視する（server 以外からの接続に備える）
        if (controlToken is not null && instruction.Token != controlToken) return;
        onInstruction(instruction);
    }

    /// <summary>積んだイベントを送り終えてから閉じる。server の終了（接続が切れた）でも戻る。</summary>
    public async ValueTask DisposeAsync()
    {
        outgoing.Writer.TryComplete();
        if (loop is not null)
        {
            try { await loop.WaitAsync(TimeSpan.FromSeconds(3)); } catch (TimeoutException) { }
        }
        stopping.Cancel();
        listener.Close();
    }
}
