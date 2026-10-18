#ifndef CWEBRTCAPM_H
#define CWEBRTCAPM_H

// WebRTC AEC3 への C の窓口（上流 helper/Sources/CWebRTCAPM/include/CWebRTCAPM.h と同じ関数。ADR 0001）。C++ の型は公開しない（実装は apm.cpp に閉じ込める）。
// 時刻合わせは呼び出し側（helper/Audio/EchoCancellation.cs）の責務で、ここは 10 ms（sample_rate / 100 サンプル）ごとの reverse / capture だけを受け持つ。
// Windows では webrtc-apm.dll として組み、C# から P/Invoke で呼ぶ。

#ifdef _WIN32
#define APM_API __declspec(dllexport)
#else
#define APM_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ApmHandle *ApmRef;

/// AEC3（`EchoCanceller3Config`）に渡す設定。
typedef struct {
    /// `ep_strength.default_gain`: エコー経路の強さの初期値（AEC3 の既定は 1）
    float ep_strength_default_gain;
} ApmEchoSettings;

/// 指定のサンプルレート・チャンネル数・AEC3 の設定で APM を作る。`settings` が NULL か、設定が AEC3 の検証を通らなければ NULL。
APM_API ApmRef apm_create(int sample_rate, int channels, const ApmEchoSettings *settings);

/// 参照（スピーカーに出た音）の 10 ms 分を渡す。`frames` は sample_rate / 100。成功なら 0。
APM_API int apm_process_reverse(ApmRef handle, const float *frame, int frames);

/// マイクの 10 ms 分を処理し、その場で書き換える。`frames` は sample_rate / 100。成功なら 0。
APM_API int apm_process_capture(ApmRef handle, float *frame, int frames);

APM_API void apm_destroy(ApmRef handle);

#ifdef __cplusplus
}
#endif

#endif
