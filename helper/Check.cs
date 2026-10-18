using System.Text.Json;
using Microsoft.Win32;

namespace Mindmap.Helper;

/// <summary>
/// 開始前の確かめ（`check`）。server/src/helpers.ts の HelperCheckSchema と同じ形の JSON を 1 行出す。
/// microphone: Windows の プライバシー設定（マイク）でデスクトップ アプリに許可があるか。sttModel: 端末内 STT のモデルがあるか。
/// </summary>
public static class Check
{
    // 設定 > プライバシーとセキュリティ > マイク の値。全体と「デスクトップ アプリ」の両方が Allow のときだけ使える
    private const string ConsentKey = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    public static string Microphone()
    {
        using var key = Registry.CurrentUser.OpenSubKey(ConsentKey);
        if (key is null) return "notDetermined";
        var global = key.GetValue("Value") as string;
        using var nonPackaged = key.OpenSubKey("NonPackaged");
        var desktop = nonPackaged?.GetValue("Value") as string;
        if (global == "Deny" || desktop == "Deny") return "denied";
        if (global == "Allow" && (desktop is null || desktop == "Allow")) return "authorized";
        return "notDetermined";
    }

    /// <summary>端末内 STT のモデルの置き場。sherpa-onnx のストリーミングモデルを展開したフォルダ（helper/README.md）。</summary>
    public static string ModelDirectory =>
        Environment.GetEnvironmentVariable("MINDMAP_STT_MODEL")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "mindmap", "models", "stt");

    public static string SttModel() => Transcription.ModelFiles.Find(ModelDirectory) is null ? "missing" : "installed";

    public static string Json() => JsonSerializer.Serialize(new { microphone = Microphone(), sttModel = SttModel() });
}
