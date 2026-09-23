#pragma once

#include <uvc_camera.h>

#include <algorithm>
#include <cmath>
#include <mutex>
#include <vector>

enum class PresenceState {
    Searching,
    Observing,
    Cooldown,
};

inline const char* StateName(PresenceState state) {
    switch (state) {
        case PresenceState::Searching:
            return "SEARCHING";
        case PresenceState::Observing:
            return "OBSERVING";
        case PresenceState::Cooldown:
            return "COOLDOWN";
    }
    return "UNKNOWN";
}

// Runtime configuration shared by the detector thread and the debug UI.
// Rectangle/ROI values use the SDK's normalized 0..1 coordinate space.
struct DetectorConfig {
    int polling_hz = 5;

    float min_head_width = 0.04f;
    float min_head_height = 0.08f;
    float frame_margin = 0.00f;
    float roi_left = 0.00f;
    float roi_right = 1.00f;
    float roi_top = 0.00f;
    float roi_bottom = 1.00f;

    float max_center_jump = 0.25f;
    float min_area_ratio = 0.25f;
    float max_area_ratio = 4.00f;

    int window_seconds = 4;
    int valid_ratio_percent = 80;
    int minimum_dwell_ms = 4000;
    int missing_tolerance_ms = 800;
    int cooldown_ms = 30000;
    bool require_leave_before_rearm = true;

    int WindowSampleCount() const {
        return std::max(1, polling_hz * window_seconds);
    }

    int RequiredValidSamples() const {
        return std::max(1, static_cast<int>(std::ceil(
            WindowSampleCount() * valid_ratio_percent / 100.0)));
    }

    void Normalize() {
        polling_hz = std::max(1, std::min(20, polling_hz));
        min_head_width = std::max(0.01f, std::min(0.50f, min_head_width));
        min_head_height = std::max(0.01f, std::min(0.60f, min_head_height));
        frame_margin = std::max(0.0f, std::min(0.20f, frame_margin));

        roi_left = std::max(0.0f, std::min(0.99f, roi_left));
        roi_right = std::max(0.01f, std::min(1.0f, roi_right));
        roi_top = std::max(0.0f, std::min(0.99f, roi_top));
        roi_bottom = std::max(0.01f, std::min(1.0f, roi_bottom));
        if (roi_left >= roi_right) {
            roi_left = std::max(0.0f, roi_right - 0.01f);
        }
        if (roi_top >= roi_bottom) {
            roi_top = std::max(0.0f, roi_bottom - 0.01f);
        }

        max_center_jump = std::max(0.01f, std::min(1.50f, max_center_jump));
        min_area_ratio = std::max(0.05f, std::min(1.0f, min_area_ratio));
        max_area_ratio = std::max(1.0f, std::min(10.0f, max_area_ratio));
        window_seconds = std::max(1, std::min(20, window_seconds));
        valid_ratio_percent = std::max(10, std::min(100, valid_ratio_percent));
        minimum_dwell_ms = std::max(500, std::min(20000, minimum_dwell_ms));
        missing_tolerance_ms = std::max(0, std::min(5000, missing_tolerance_ms));
        cooldown_ms = std::max(0, std::min(300000, cooldown_ms));
    }
};

class DetectorConfigStore {
public:
    DetectorConfig Get() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return value_;
    }

    void Set(DetectorConfig value) {
        value.Normalize();
        std::lock_guard<std::mutex> lock(mutex_);
        value_ = value;
    }

private:
    mutable std::mutex mutex_;
    DetectorConfig value_;
};

struct DetectorDebugState {
    bool sdk_ok = false;
    bool stream_open = false;
    std::vector<UVCRect> heads;
    std::vector<unsigned char> head_usable;
    bool has_target = false;
    bool target_changed = false;
    int usable_head_count = 0;
    PresenceState state = PresenceState::Searching;
    int valid_samples = 0;
    int total_samples = 0;
    long long dwell_ms = 0;
    long long cooldown_remaining_ms = 0;
};

class DetectorStateStore {
public:
    DetectorDebugState Get() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return value_;
    }

    void Set(const DetectorDebugState& value) {
        std::lock_guard<std::mutex> lock(mutex_);
        value_ = value;
    }

private:
    mutable std::mutex mutex_;
    DetectorDebugState value_;
};
