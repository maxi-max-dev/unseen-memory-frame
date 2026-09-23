#include <uvc_camera.h>

#include "debug_ui.h"
#include "detector_types.h"
#include "video_stream_capture.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdint>
#include <deque>
#include <iomanip>
#include <iostream>
#include <limits>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

using namespace uvc;

namespace {

std::atomic<bool> g_running(true);

void SignalHandler(int) {
    g_running.store(false);
}

using Clock = std::chrono::steady_clock;
using TimePoint = Clock::time_point;

long long ToMilliseconds(Clock::duration duration) {
    return std::chrono::duration_cast<std::chrono::milliseconds>(duration).count();
}

struct DetectionSummary {
    bool has_target = false;
    bool target_changed = false;
    std::size_t raw_head_count = 0;
    std::size_t usable_head_count = 0;
    std::vector<unsigned char> head_usable;
    UVCRect target{};
};

struct DwellResult {
    bool triggered = false;
    PresenceState state = PresenceState::Searching;
    int valid_samples = 0;
    int total_samples = 0;
    long long dwell_ms = 0;
    long long cooldown_remaining_ms = 0;
};

float RectArea(const UVCRect& rect) {
    return rect.width * rect.height;
}

float RectCenterX(const UVCRect& rect) {
    return rect.point.x + rect.width * 0.5f;
}

float RectCenterY(const UVCRect& rect) {
    return rect.point.y + rect.height * 0.5f;
}

bool IsFiniteRect(const UVCRect& rect) {
    return std::isfinite(rect.point.x) && std::isfinite(rect.point.y) &&
           std::isfinite(rect.width) && std::isfinite(rect.height);
}

bool IsUsableHeadRect(const UVCRect& rect, const DetectorConfig& config) {
    if (!IsFiniteRect(rect)) {
        return false;
    }
    if (rect.width < config.min_head_width ||
        rect.height < config.min_head_height || rect.width > 1.0f ||
        rect.height > 1.0f) {
        return false;
    }

    const float right = rect.point.x + rect.width;
    const float bottom = rect.point.y + rect.height;
    if (rect.point.x < config.frame_margin ||
        rect.point.y < config.frame_margin ||
        right > 1.0f - config.frame_margin ||
        bottom > 1.0f - config.frame_margin) {
        return false;
    }

    const float center_x = RectCenterX(rect);
    const float center_y = RectCenterY(rect);
    return center_x >= config.roi_left && center_x <= config.roi_right &&
           center_y >= config.roi_top && center_y <= config.roi_bottom;
}

class TargetSelector {
public:
    DetectionSummary Select(const std::vector<UVCRect>& heads,
                            const DetectorConfig& config) {
        DetectionSummary result;
        result.raw_head_count = heads.size();
        result.head_usable.reserve(heads.size());

        std::vector<UVCRect> usable;
        for (const auto& head : heads) {
            const bool valid = IsUsableHeadRect(head, config);
            result.head_usable.push_back(valid ? 1 : 0);
            if (valid) {
                usable.push_back(head);
            }
        }
        result.usable_head_count = usable.size();

        // One unambiguous head is required. Two or more usable heads make the
        // current sample invalid rather than arbitrarily choosing a person.
        if (usable.size() != 1) {
            return result;
        }

        result.has_target = true;
        result.target = usable.front();
        if (has_previous_) {
            const float dx = RectCenterX(result.target) - RectCenterX(previous_);
            const float dy = RectCenterY(result.target) - RectCenterY(previous_);
            const float center_distance = std::sqrt(dx * dx + dy * dy);
            const float previous_area = std::max(
                RectArea(previous_), std::numeric_limits<float>::epsilon());
            const float area_ratio = RectArea(result.target) / previous_area;
            result.target_changed = center_distance > config.max_center_jump ||
                                    area_ratio < config.min_area_ratio ||
                                    area_ratio > config.max_area_ratio;
        }
        previous_ = result.target;
        has_previous_ = true;
        return result;
    }

private:
    bool has_previous_ = false;
    UVCRect previous_{};
};

class DwellDetector {
public:
    DwellResult Update(bool valid_target, const TimePoint now,
                       const DetectorConfig& config) {
        if (state_ == PresenceState::Cooldown) {
            return UpdateCooldown(valid_target, now, config);
        }

        samples_.push_back(valid_target);
        while (static_cast<int>(samples_.size()) >
               config.WindowSampleCount()) {
            samples_.pop_front();
        }

        if (valid_target) {
            if (!has_observation_start_) {
                observation_start_ = now;
                has_observation_start_ = true;
            }
            last_valid_target_ = now;
            has_last_valid_target_ = true;
            state_ = PresenceState::Observing;
        } else if (has_last_valid_target_ &&
                   ToMilliseconds(now - last_valid_target_) >
                       config.missing_tolerance_ms) {
            ResetObservation();
        }

        DwellResult result = Snapshot(now);
        const bool window_ready =
            result.total_samples == config.WindowSampleCount();
        const bool ratio_ready =
            result.valid_samples >= config.RequiredValidSamples();
        const bool dwell_ready = result.dwell_ms >= config.minimum_dwell_ms;
        const bool recently_seen = has_last_valid_target_ &&
            ToMilliseconds(now - last_valid_target_) <=
                config.missing_tolerance_ms;

        if (window_ready && ratio_ready && dwell_ready && recently_seen) {
            state_ = PresenceState::Cooldown;
            cooldown_start_ = now;
            saw_confirmed_leave_during_cooldown_ = false;
            result = Snapshot(now);
            result.triggered = true;
        }
        return result;
    }

    void ResetForNewTarget() {
        if (state_ != PresenceState::Cooldown) {
            ResetObservation();
        }
    }

private:
    DwellResult UpdateCooldown(bool valid_target, const TimePoint now,
                               const DetectorConfig& config) {
        if (valid_target) {
            last_valid_target_ = now;
            has_last_valid_target_ = true;
        } else if (has_last_valid_target_ &&
                   ToMilliseconds(now - last_valid_target_) >
                       config.missing_tolerance_ms) {
            saw_confirmed_leave_during_cooldown_ = true;
        }

        const long long elapsed = ToMilliseconds(now - cooldown_start_);
        const bool cooldown_finished = elapsed >= config.cooldown_ms;
        const bool rearm_allowed = !config.require_leave_before_rearm ||
                                   saw_confirmed_leave_during_cooldown_;
        if (cooldown_finished && rearm_allowed) {
            ResetObservation();
            return Snapshot(now);
        }

        DwellResult result = Snapshot(now);
        result.cooldown_remaining_ms =
            std::max<long long>(0, config.cooldown_ms - elapsed);
        return result;
    }

    DwellResult Snapshot(const TimePoint now) const {
        DwellResult result;
        result.state = state_;
        result.total_samples = static_cast<int>(samples_.size());
        result.valid_samples = static_cast<int>(
            std::count(samples_.begin(), samples_.end(), true));
        if (has_observation_start_) {
            result.dwell_ms = ToMilliseconds(now - observation_start_);
        }
        return result;
    }

    void ResetObservation() {
        state_ = PresenceState::Searching;
        samples_.clear();
        has_observation_start_ = false;
        has_last_valid_target_ = false;
        saw_confirmed_leave_during_cooldown_ = false;
    }

    PresenceState state_ = PresenceState::Searching;
    std::deque<bool> samples_;
    TimePoint observation_start_{};
    TimePoint last_valid_target_{};
    TimePoint cooldown_start_{};
    bool has_observation_start_ = false;
    bool has_last_valid_target_ = false;
    bool saw_confirmed_leave_during_cooldown_ = false;
};

void PrintConfiguration(const DetectorConfig& config) {
    std::cout << "Polling: " << config.polling_hz << " Hz\n"
              << "Window: " << config.window_seconds << " s / "
              << config.WindowSampleCount() << " samples\n"
              << "Required: " << config.RequiredValidSamples() << "/"
              << config.WindowSampleCount() << " samples ("
              << config.valid_ratio_percent << "%)\n"
              << "Minimum dwell: " << config.minimum_dwell_ms / 1000.0
              << " s\nMissing tolerance: "
              << config.missing_tolerance_ms / 1000.0 << " s\nCooldown: "
              << config.cooldown_ms / 1000.0 << " s\n\n";
}

void PrintTrigger(const DwellResult& result,
                  const DetectionSummary& detection) {
    const auto unix_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();

    std::cout << "\n============================================================\n"
              << "检测到用户在相框前驻足\n"
              << "dwellMs=" << result.dwell_ms
              << ", validSamples=" << result.valid_samples << "/"
              << result.total_samples << "\n"
              << "EVENT:{\"type\":\"presence.dwell\",\"timestamp\":"
              << unix_ms << ",\"dwellMs\":" << result.dwell_ms
              << ",\"headCount\":" << detection.raw_head_count << "}\n"
              << "============================================================\n" << std::flush;
}

void PrintStatus(bool sdk_ok, const DetectionSummary& detection,
                 const DwellResult& result) {
    const double ratio = result.total_samples == 0 ? 0.0 :
        static_cast<double>(result.valid_samples) / result.total_samples;
    std::cout << "[" << StateName(result.state) << "] sdk="
              << (sdk_ok ? "ok" : "error")
              << " heads=" << detection.raw_head_count
              << " usable=" << detection.usable_head_count
              << " window=" << result.valid_samples << "/"
              << result.total_samples << " ratio=" << std::fixed
              << std::setprecision(0) << ratio * 100.0 << "% dwell="
              << std::setprecision(1) << result.dwell_ms / 1000.0 << "s";
    if (result.state == PresenceState::Cooldown) {
        std::cout << " cooldown=" << result.cooldown_remaining_ms / 1000.0
                  << "s";
    }
    std::cout << std::endl;
}

DetectorDebugState MakeDebugState(bool sdk_ok, bool stream_open,
                                  const std::vector<UVCRect>& heads,
                                  const DetectionSummary& detection,
                                  const DwellResult& result) {
    DetectorDebugState state;
    state.sdk_ok = sdk_ok;
    state.stream_open = stream_open;
    state.heads = heads;
    state.head_usable = detection.head_usable;
    state.has_target = detection.has_target;
    state.target_changed = detection.target_changed;
    state.usable_head_count =
        static_cast<int>(detection.usable_head_count);
    state.state = result.state;
    state.valid_samples = result.valid_samples;
    state.total_samples = result.total_samples;
    state.dwell_ms = result.dwell_ms;
    state.cooldown_remaining_ms = result.cooldown_remaining_ms;
    return state;
}

void DetectionLoop(const UVCCameraInfo& camera_info,
                   DetectorConfigStore& config_store,
                   DetectorStateStore& state_store) {
    UVCCameraExtendController extend_controller(camera_info);
    TargetSelector target_selector;
    DwellDetector dwell_detector;

    TimePoint next_poll = Clock::now();
    TimePoint next_status = Clock::now();
    TimePoint next_device_status = Clock::now();
    int consecutive_sdk_errors = 0;
    bool stream_open = false;

    while (g_running.load()) {
        const DetectorConfig config = config_store.Get();
        const int polling_interval_ms =
            std::max(1, 1000 / config.polling_hz);
        next_poll += std::chrono::milliseconds(polling_interval_ms);

        std::vector<UVCRect> heads;
        const bool sdk_ok = extend_controller.GetNewTrackObjLists(heads);
        const TimePoint now = Clock::now();

        DetectionSummary detection;
        if (sdk_ok) {
            consecutive_sdk_errors = 0;
            detection = target_selector.Select(heads, config);
        } else {
            ++consecutive_sdk_errors;
        }

        if (detection.target_changed) {
            dwell_detector.ResetForNewTarget();
        }
        const DwellResult result =
            dwell_detector.Update(detection.has_target, now, config);
        if (result.triggered) {
            PrintTrigger(result, detection);
        }

        if (now >= next_device_status) {
            DeviceStatus device_status{};
            if (extend_controller.GetDeviceStatus(device_status)) {
                stream_open = device_status.video_stream_is_opend;
            }
            next_device_status = now + std::chrono::seconds(2);
        }

        state_store.Set(MakeDebugState(sdk_ok, stream_open, heads,
                                       detection, result));

        if (now >= next_status || consecutive_sdk_errors == 1) {
            PrintStatus(sdk_ok, detection, result);
            next_status = now + std::chrono::seconds(1);
        }
        if (consecutive_sdk_errors == 5) {
            std::cerr << "GetNewTrackObjLists failed repeatedly. Close other "
                         "camera/control applications or reconnect Link 2. "
                         "Polling is reduced to 1 Hz until it recovers."
                      << std::endl;
        }

        const TimePoint after_work = Clock::now();
        if (consecutive_sdk_errors >= 5) {
            // The vendor SDK logs every failed request. Back off after a real
            // disconnect so the console remains usable and the UI responsive.
            next_poll = after_work + std::chrono::seconds(1);
        }
        if (next_poll < after_work) {
            next_poll = after_work;
        }
        std::this_thread::sleep_until(next_poll);
    }
}

}  // namespace

int main() {
#ifdef _WIN32
    SetConsoleOutputCP(CP_UTF8);
    SetConsoleCP(CP_UTF8);
#endif
    std::signal(SIGINT, SignalHandler);

    DetectorConfigStore config_store;
    DetectorStateStore state_store;
    PrintConfiguration(config_store.Get());

    std::vector<UVCCameraInfo> cameras;
    GetUVCCameraList(cameras);
    if (cameras.empty()) {
        std::cerr << "No UVC camera found. Connect Link 2 and retry."
                  << std::endl;
        return 1;
    }

    // Ignore unrelated UVC cameras (for example the built-in laptop webcam).
    // Multiple matching Link 2 devices are ambiguous and are not supported.
    std::vector<UVCCameraInfo> link2_cameras;
    for (const auto& camera : cameras) {
        if (camera.friendly_name.find("Insta360 Link 2") != std::string::npos) {
            link2_cameras.push_back(camera);
        }
    }
    if (link2_cameras.size() != 1) {
        std::cerr << "Connect exactly one matching Insta360 Link 2 camera. "
                     "No matching device or multiple Link 2 devices were found."
                  << std::endl;
        return 1;
    }
    const UVCCameraInfo camera_info = link2_cameras.front();
    std::cout << "Selected camera: " << camera_info.friendly_name << "\n"
              << "VID=0x" << std::hex << camera_info.vendor_id
              << " PID=0x" << camera_info.product_id << std::dec << "\n"
              << "Close the debug window or press Ctrl+C to stop.\n\n";

    VideoStreamCapture video_stream;
    if (!video_stream.Start(camera_info.display_name)) {
        std::cerr << "Unable to start the Link 2 video/frame stream."
                  << std::endl;
        return 2;
    }

    std::thread detector(DetectionLoop, std::cref(camera_info),
                         std::ref(config_store), std::ref(state_store));
    const int ui_result = RunDebugUi(video_stream, config_store, state_store,
                                     g_running);
    g_running.store(false);
    if (detector.joinable()) {
        detector.join();
    }
    video_stream.Stop();
    std::cout << "Stopped." << std::endl;
    return ui_result;
}
