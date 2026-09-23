#pragma once

#include "detector_types.h"
#include "video_stream_capture.h"

#include <atomic>

// Runs the Win32 debug window until the user closes it. The detector continues
// on its worker thread and publishes snapshots through DetectorStateStore.
int RunDebugUi(VideoStreamCapture& video,
               DetectorConfigStore& config,
               DetectorStateStore& state,
               std::atomic<bool>& running);
