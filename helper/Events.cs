using System.Text.Json;
using System.Text.Json.Serialization;

namespace Mindmap.Helper;

/// <summary>発言のトラック。値は server の Track（server/src/core/remark.ts）と同じ文字列。</summary>
public static class Track
{
    public const string Self = "自分";
    public const string Other = "相手";
}

/// <summary>本文の 1 区間の時刻（server/src/core/words.ts の WordTime）。location / length は本文の UTF-16 の位置、start / end は秒。</summary>
public sealed record WordTime(int location, int length, double start, double end);

/// <summary>STT が返す 1 件の結果。start / end はトラック内（または原点からの）秒。WordTimes は時刻を持たない STT では空。</summary>
public sealed record TranscriptionResult(string Text, bool IsFinal, double Start, double End, IReadOnlyList<WordTime>? WordTimes = null);

/// <summary>
/// WebSocket に流すイベント（server/src/core/live.ts の HelperEvent と同じ形）。
/// 1 行の JSON にして、テキストフレームで送る。
/// </summary>
public static class Events
{
    private static readonly JsonSerializerOptions Options = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    private static string Json(object value) => JsonSerializer.Serialize(value, Options);

    /// <summary>確定結果（remark）と途中結果（partial）。words は初版では空（語彙補正は無い）、wordTimes は時刻を持たない STT では空（ADR 0001）。</summary>
    public static string Remark(string track, TranscriptionResult result, bool duplicate = false) =>
        Json(new { type = result.IsFinal ? "remark" : "partial", track, start = result.Start, end = result.End, text = result.Text, duplicate, words = Array.Empty<object>(), wordTimes = result.WordTimes ?? [] });

    /// <summary>VAD が区間を閉じた。その区間の確定結果より先に送る。本文は持たない。start は確定結果と同じ揃え方。</summary>
    public static string SegmentEnd(string track, double start, double end) =>
        Json(new { type = "segment-end", track, start, end });

    /// <summary>2 トラック共通の時刻の原点。64 bit の値は JSON の number では桁が落ちるので、数字だけの文字列にする。wallTime は原点（音声の時刻 0）に当たる壁時計の Unix ms で、ms なら number で足りる。</summary>
    public static string Origin(long hostTime, long wallTime) =>
        Json(new { type = "origin", hostTime = hostTime.ToString(System.Globalization.CultureInfo.InvariantCulture), wallTime });

    /// <summary>話者分離を使えない。話者分離のモデルを持たない初版は、起動直後（origin の次）に 1 回だけ送る。</summary>
    public static string SpeakerOff(double start) => Json(new { type = "speaker-off", start, reason = "モデルなし" });

    /// <summary>自分の休止の状態が変わった。初版の理由は手動だけ。</summary>
    public static string SelfPause(bool paused, double start) =>
        Json(paused ? new { type = "self-pause", paused = true, reason = "手動", start } : new { type = "self-pause", paused = false, reason = "手動", start });

    /// <summary>自分の休止の規則の状態。起動し直しで server が引数（--self-manual）として送り直す。自動の判定は初版では無いので basis / lastKnown は unknown。</summary>
    public static string SelfPauseState(string manual) => Json(new { type = "self-pause-state", manual, basis = "unknown", lastKnown = "unknown", idleFor = 0 });

    /// <summary>相手の音が 10 秒届かなかった。</summary>
    public static string TapSilent(double start) => Json(new { type = "tap-silent", start });
}

/// <summary>server から helper への指示（server/src/helpers.ts の HelperInstruction）。token は起動ごとの合言葉。</summary>
public sealed record Instruction(
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("paused")] bool Paused,
    [property: JsonPropertyName("token")] string? Token);
