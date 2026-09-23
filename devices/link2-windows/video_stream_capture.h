#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

struct VideoFrame {
    int width = 0;
    int height = 0;
    bool bottom_up = true;
    std::vector<std::uint8_t> bgr24;
};

// Owns the single DirectShow graph used by this process. The graph both
// activates Link 2's firmware detection and exposes RGB frames to the UI.
class VideoStreamCapture {
public:
    VideoStreamCapture();
    ~VideoStreamCapture();

    VideoStreamCapture(const VideoStreamCapture&) = delete;
    VideoStreamCapture& operator=(const VideoStreamCapture&) = delete;

    bool Start(const std::string& display_name);
    void Stop();
    bool CopyLatestFrame(VideoFrame& frame) const;

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};
