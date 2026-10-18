using System.Diagnostics;
using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;

namespace Mindmap.Helper;

/// <summary>
/// 会議アプリの一覧（`list`）。既定の再生デバイスで音を出しているプロセス（音声セッション）を、実行ファイル名を id にして出す。
/// `run --app` にはこの id を渡す。PID は list と run の間で変わりうるので、id にはしない。
/// </summary>
public static class Apps
{
    public sealed record App(string id, string name, int pid, bool active);

    public static IReadOnlyList<App> List()
    {
        using var enumerator = new MMDeviceEnumerator();
        using var device = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
        var sessions = device.AudioSessionManager.Sessions;
        var apps = new Dictionary<string, App>();
        for (var i = 0; i < sessions.Count; i++)
        {
            using var session = sessions[i];
            var pid = (int)session.GetProcessID;
            if (pid == 0 || session.IsSystemSoundsSession) continue;
            string processName;
            try { processName = Process.GetProcessById(pid).ProcessName; }
            catch (ArgumentException) { continue; } // list の途中で終わったプロセス
            var id = processName + ".exe";
            var active = session.State == AudioSessionState.AudioSessionStateActive;
            // 同じアプリの複数のセッションは 1 つにまとめ、音を出しているものを優先する
            if (!apps.TryGetValue(id, out var known) || (active && !known.active)) apps[id] = new App(id, processName, pid, active);
        }
        return apps.Values.OrderByDescending(a => a.active).ThenBy(a => a.name).ToList();
    }

    public static string ListJson() => JsonSerializer.Serialize(List(), new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });

    /// <summary>
    /// `--app` の id（実行ファイル名）から、Process Loopback の対象にする PID を引く。音声セッションを持つプロセス（音を出している側）を優先し、
    /// 無ければ同じ名前のうち最初に始まったもの（会議アプリの親。子プロセスの音は INCLUDE_TARGET_PROCESS_TREE で一緒に取れる）。動いていなければ null。
    /// </summary>
    public static int? ResolvePid(string id)
    {
        var name = id.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? id[..^4] : id;
        var withSession = List().FirstOrDefault(a => string.Equals(a.id, name + ".exe", StringComparison.OrdinalIgnoreCase));
        if (withSession is not null) return withSession.pid;
        return Process.GetProcessesByName(name).OrderBy(StartTimeOf).Select(p => (int?)p.Id).FirstOrDefault();
    }

    private static DateTime StartTimeOf(Process process)
    {
        try { return process.StartTime; }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException) { return DateTime.MaxValue; } // 権限が無い・もう終わった
    }
}
