#include "debug_ui.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <commctrl.h>

#include <algorithm>
#include <cmath>
#include <cwchar>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr wchar_t kWindowClassName[] = L"Link2DwellDebugWindow";
constexpr int kPanelWidth = 430;
constexpr int kControlTop = 58;
constexpr int kControlRowHeight = 43;
constexpr UINT_PTR kRefreshTimer = 1;
constexpr int kRequireLeaveId = 1900;

enum class Parameter {
    PollHz,
    MinHeadWidth,
    MinHeadHeight,
    FrameMargin,
    RoiLeft,
    RoiRight,
    RoiTop,
    RoiBottom,
    MaxCenterJump,
    MinAreaRatio,
    MaxAreaRatio,
    WindowSeconds,
    ValidRatio,
    MinimumDwell,
    MissingTolerance,
    Cooldown,
};

struct ControlBinding {
    Parameter parameter;
    const wchar_t* name;
    HWND label = nullptr;
    HWND value = nullptr;
    HWND slider = nullptr;
    int minimum = 0;
    int maximum = 100;
};

struct UiContext {
    VideoStreamCapture* video = nullptr;
    DetectorConfigStore* config = nullptr;
    DetectorStateStore* state = nullptr;
    std::atomic<bool>* running = nullptr;
    std::vector<ControlBinding> controls;
    HWND derived_label = nullptr;
    HWND require_leave = nullptr;
    HFONT font = nullptr;
};

int PanelLeft(HWND window) {
    RECT client{};
    GetClientRect(window, &client);
    return std::max(520, static_cast<int>(client.right) - kPanelWidth);
}

void SetControlFont(HWND control, HFONT font) {
    SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
}

void AddControl(HWND window, UiContext& context, Parameter parameter,
                const wchar_t* name, int minimum, int maximum) {
    ControlBinding binding;
    binding.parameter = parameter;
    binding.name = name;
    binding.minimum = minimum;
    binding.maximum = maximum;
    binding.label = CreateWindowW(L"STATIC", name, WS_CHILD | WS_VISIBLE,
                                  0, 0, 1, 1, window, nullptr, nullptr, nullptr);
    binding.value = CreateWindowW(L"STATIC", L"", WS_CHILD | WS_VISIBLE |
                                  SS_RIGHT, 0, 0, 1, 1, window, nullptr,
                                  nullptr, nullptr);
    binding.slider = CreateWindowExW(
        0, TRACKBAR_CLASSW, L"", WS_CHILD | WS_VISIBLE | TBS_HORZ |
        TBS_NOTICKS, 0, 0, 1, 1, window, nullptr, nullptr, nullptr);
    SendMessageW(binding.slider, TBM_SETRANGE, TRUE,
                 MAKELPARAM(minimum, maximum));
    SendMessageW(binding.slider, TBM_SETPAGESIZE, 0,
                 std::max(1, (maximum - minimum) / 10));
    SetControlFont(binding.label, context.font);
    SetControlFont(binding.value, context.font);
    context.controls.push_back(binding);
}

int SliderPosition(const DetectorConfig& config, Parameter parameter) {
    switch (parameter) {
        case Parameter::PollHz: return config.polling_hz;
        case Parameter::MinHeadWidth:
            return static_cast<int>(std::round(config.min_head_width * 100));
        case Parameter::MinHeadHeight:
            return static_cast<int>(std::round(config.min_head_height * 100));
        case Parameter::FrameMargin:
            return static_cast<int>(std::round(config.frame_margin * 100));
        case Parameter::RoiLeft:
            return static_cast<int>(std::round(config.roi_left * 100));
        case Parameter::RoiRight:
            return static_cast<int>(std::round(config.roi_right * 100));
        case Parameter::RoiTop:
            return static_cast<int>(std::round(config.roi_top * 100));
        case Parameter::RoiBottom:
            return static_cast<int>(std::round(config.roi_bottom * 100));
        case Parameter::MaxCenterJump:
            return static_cast<int>(std::round(config.max_center_jump * 100));
        case Parameter::MinAreaRatio:
            return static_cast<int>(std::round(config.min_area_ratio * 100));
        case Parameter::MaxAreaRatio:
            return static_cast<int>(std::round(config.max_area_ratio * 100));
        case Parameter::WindowSeconds: return config.window_seconds;
        case Parameter::ValidRatio: return config.valid_ratio_percent;
        case Parameter::MinimumDwell: return config.minimum_dwell_ms / 100;
        case Parameter::MissingTolerance:
            return config.missing_tolerance_ms / 100;
        case Parameter::Cooldown: return config.cooldown_ms / 1000;
    }
    return 0;
}

std::wstring ParameterValue(const DetectorConfig& config,
                            Parameter parameter) {
    wchar_t text[80]{};
    switch (parameter) {
        case Parameter::PollHz:
            swprintf_s(text, L"%d Hz", config.polling_hz);
            break;
        case Parameter::MinHeadWidth:
            swprintf_s(text, L"%.2f", config.min_head_width);
            break;
        case Parameter::MinHeadHeight:
            swprintf_s(text, L"%.2f", config.min_head_height);
            break;
        case Parameter::FrameMargin:
            swprintf_s(text, L"%.2f", config.frame_margin);
            break;
        case Parameter::RoiLeft:
            swprintf_s(text, L"%.2f", config.roi_left);
            break;
        case Parameter::RoiRight:
            swprintf_s(text, L"%.2f", config.roi_right);
            break;
        case Parameter::RoiTop:
            swprintf_s(text, L"%.2f", config.roi_top);
            break;
        case Parameter::RoiBottom:
            swprintf_s(text, L"%.2f", config.roi_bottom);
            break;
        case Parameter::MaxCenterJump:
            swprintf_s(text, L"%.2f", config.max_center_jump);
            break;
        case Parameter::MinAreaRatio:
            swprintf_s(text, L"%.2fx", config.min_area_ratio);
            break;
        case Parameter::MaxAreaRatio:
            swprintf_s(text, L"%.2fx", config.max_area_ratio);
            break;
        case Parameter::WindowSeconds:
            swprintf_s(text, L"%d s", config.window_seconds);
            break;
        case Parameter::ValidRatio:
            swprintf_s(text, L"%d%%", config.valid_ratio_percent);
            break;
        case Parameter::MinimumDwell:
            swprintf_s(text, L"%.1f s", config.minimum_dwell_ms / 1000.0);
            break;
        case Parameter::MissingTolerance:
            swprintf_s(text, L"%.1f s", config.missing_tolerance_ms / 1000.0);
            break;
        case Parameter::Cooldown:
            swprintf_s(text, L"%.0f s", config.cooldown_ms / 1000.0);
            break;
    }
    return text;
}

void SetParameter(DetectorConfig& config, Parameter parameter, int position) {
    switch (parameter) {
        case Parameter::PollHz: config.polling_hz = position; break;
        case Parameter::MinHeadWidth: config.min_head_width = position / 100.0f; break;
        case Parameter::MinHeadHeight: config.min_head_height = position / 100.0f; break;
        case Parameter::FrameMargin: config.frame_margin = position / 100.0f; break;
        case Parameter::RoiLeft: config.roi_left = position / 100.0f; break;
        case Parameter::RoiRight: config.roi_right = position / 100.0f; break;
        case Parameter::RoiTop: config.roi_top = position / 100.0f; break;
        case Parameter::RoiBottom: config.roi_bottom = position / 100.0f; break;
        case Parameter::MaxCenterJump:
            config.max_center_jump = position / 100.0f;
            break;
        case Parameter::MinAreaRatio:
            config.min_area_ratio = position / 100.0f;
            break;
        case Parameter::MaxAreaRatio:
            config.max_area_ratio = position / 100.0f;
            break;
        case Parameter::WindowSeconds: config.window_seconds = position; break;
        case Parameter::ValidRatio: config.valid_ratio_percent = position; break;
        case Parameter::MinimumDwell:
            config.minimum_dwell_ms = position * 100;
            break;
        case Parameter::MissingTolerance:
            config.missing_tolerance_ms = position * 100;
            break;
        case Parameter::Cooldown: config.cooldown_ms = position * 1000; break;
    }
}

void SyncControls(UiContext& context) {
    const DetectorConfig config = context.config->Get();
    for (const auto& control : context.controls) {
        SendMessageW(control.slider, TBM_SETPOS, TRUE,
                     SliderPosition(config, control.parameter));
        SetWindowTextW(control.value,
                       ParameterValue(config, control.parameter).c_str());
    }
    SendMessageW(context.require_leave, BM_SETCHECK,
                 config.require_leave_before_rearm ? BST_CHECKED : BST_UNCHECKED,
                 0);

    wchar_t derived[160]{};
    swprintf_s(derived, L"Derived window: %d samples, required: %d",
               config.WindowSampleCount(), config.RequiredValidSamples());
    SetWindowTextW(context.derived_label, derived);
}

void LayoutControls(HWND window, UiContext& context) {
    RECT client{};
    GetClientRect(window, &client);
    const int panel_left = PanelLeft(window);
    const int x = panel_left + 14;
    const int width = std::max(200, static_cast<int>(client.right) - x - 14);

    MoveWindow(context.derived_label, x, 28, width, 22, TRUE);
    for (std::size_t i = 0; i < context.controls.size(); ++i) {
        const int y = kControlTop + static_cast<int>(i) * kControlRowHeight;
        MoveWindow(context.controls[i].label, x, y, width - 105, 18, TRUE);
        MoveWindow(context.controls[i].value, x + width - 100, y, 100, 18, TRUE);
        MoveWindow(context.controls[i].slider, x, y + 17, width, 24, TRUE);
    }
    const int check_y = kControlTop +
        static_cast<int>(context.controls.size()) * kControlRowHeight + 3;
    MoveWindow(context.require_leave, x, check_y, width, 24, TRUE);
}

bool IsUsableForUi(const UVCRect& rect, const DetectorConfig& config) {
    const float right = rect.point.x + rect.width;
    const float bottom = rect.point.y + rect.height;
    if (!std::isfinite(rect.point.x) || !std::isfinite(rect.point.y) ||
        !std::isfinite(rect.width) || !std::isfinite(rect.height) ||
        rect.width < config.min_head_width ||
        rect.height < config.min_head_height || rect.width > 1.0f ||
        rect.height > 1.0f || rect.point.x < config.frame_margin ||
        rect.point.y < config.frame_margin ||
        right > 1.0f - config.frame_margin ||
        bottom > 1.0f - config.frame_margin) {
        return false;
    }
    const float center_x = rect.point.x + rect.width * 0.5f;
    const float center_y = rect.point.y + rect.height * 0.5f;
    return center_x >= config.roi_left && center_x <= config.roi_right &&
           center_y >= config.roi_top && center_y <= config.roi_bottom;
}

RECT NormalizedRect(const UVCRect& rect, const RECT& video) {
    const int width = video.right - video.left;
    const int height = video.bottom - video.top;
    RECT result{};
    result.left = video.left + static_cast<int>(rect.point.x * width);
    result.top = video.top + static_cast<int>(rect.point.y * height);
    result.right = result.left + static_cast<int>(rect.width * width);
    result.bottom = result.top + static_cast<int>(rect.height * height);
    return result;
}

void DrawDebugView(HWND window, UiContext& context, HDC target) {
    RECT client{};
    GetClientRect(window, &client);
    const int width = client.right;
    const int height = client.bottom;
    if (width <= 0 || height <= 0) {
        return;
    }

    HDC canvas = CreateCompatibleDC(target);
    HBITMAP bitmap = CreateCompatibleBitmap(target, width, height);
    HGDIOBJ old_bitmap = SelectObject(canvas, bitmap);

    HBRUSH dark = CreateSolidBrush(RGB(18, 20, 24));
    FillRect(canvas, &client, dark);
    DeleteObject(dark);

    const int panel_left = PanelLeft(window);
    RECT panel{panel_left, 0, width, height};
    HBRUSH panel_brush = CreateSolidBrush(RGB(245, 246, 248));
    FillRect(canvas, &panel, panel_brush);
    DeleteObject(panel_brush);

    VideoFrame frame;
    RECT video_rect{0, 0, panel_left, height};
    RECT image_rect = video_rect;
    if (context.video->CopyLatestFrame(frame) && frame.width > 0 &&
        frame.height > 0 && !frame.bgr24.empty()) {
        const double scale = std::min(
            video_rect.right / static_cast<double>(frame.width),
            video_rect.bottom / static_cast<double>(frame.height));
        const int draw_width = std::max(1, static_cast<int>(frame.width * scale));
        const int draw_height = std::max(1, static_cast<int>(frame.height * scale));
        image_rect.left = (video_rect.right - draw_width) / 2;
        image_rect.top = (video_rect.bottom - draw_height) / 2;
        image_rect.right = image_rect.left + draw_width;
        image_rect.bottom = image_rect.top + draw_height;

        BITMAPINFO info{};
        info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        info.bmiHeader.biWidth = frame.width;
        info.bmiHeader.biHeight = frame.bottom_up ? frame.height : -frame.height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 24;
        info.bmiHeader.biCompression = BI_RGB;
        SetStretchBltMode(canvas, HALFTONE);
        StretchDIBits(canvas, image_rect.left, image_rect.top,
                      draw_width, draw_height, 0, 0, frame.width, frame.height,
                      frame.bgr24.data(), &info, DIB_RGB_COLORS, SRCCOPY);
    } else {
        SetBkMode(canvas, TRANSPARENT);
        SetTextColor(canvas, RGB(220, 220, 220));
        SelectObject(canvas, context.font);
        DrawTextW(canvas, L"Waiting for Link 2 video frames...", -1,
                  &video_rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    }

    const DetectorConfig config = context.config->Get();
    const DetectorDebugState state = context.state->Get();

    RECT roi{
        image_rect.left + static_cast<int>(config.roi_left *
                                           (image_rect.right - image_rect.left)),
        image_rect.top + static_cast<int>(config.roi_top *
                                          (image_rect.bottom - image_rect.top)),
        image_rect.left + static_cast<int>(config.roi_right *
                                           (image_rect.right - image_rect.left)),
        image_rect.top + static_cast<int>(config.roi_bottom *
                                          (image_rect.bottom - image_rect.top))};
    HPEN roi_pen = CreatePen(PS_DASH, 2, RGB(255, 210, 40));
    HGDIOBJ old_pen = SelectObject(canvas, roi_pen);
    HGDIOBJ old_brush = SelectObject(canvas, GetStockObject(HOLLOW_BRUSH));
    Rectangle(canvas, roi.left, roi.top, roi.right, roi.bottom);
    SelectObject(canvas, old_pen);
    DeleteObject(roi_pen);

    for (const auto& head : state.heads) {
        const bool usable = IsUsableForUi(head, config);
        const COLORREF color = usable ? RGB(40, 230, 90) : RGB(255, 70, 70);
        HPEN head_pen = CreatePen(PS_SOLID, 3, color);
        old_pen = SelectObject(canvas, head_pen);
        const RECT rect = NormalizedRect(head, image_rect);
        Rectangle(canvas, rect.left, rect.top, rect.right, rect.bottom);
        SelectObject(canvas, old_pen);
        DeleteObject(head_pen);
    }
    SelectObject(canvas, old_brush);

    const double ratio = state.total_samples == 0 ? 0.0 :
        state.valid_samples * 100.0 / state.total_samples;
    std::wostringstream status;
    status << L"State: ";
    if (state.state == PresenceState::Searching) status << L"SEARCHING";
    if (state.state == PresenceState::Observing) status << L"OBSERVING";
    if (state.state == PresenceState::Cooldown) status << L"COOLDOWN";
    status << L"   SDK: " << (state.sdk_ok ? L"OK" : L"ERROR")
           << L"   Stream: " << (state.stream_open ? L"OPEN" : L"CLOSED")
           << L"\nHeads: " << state.heads.size() << L" / usable "
           << state.usable_head_count
           << L"   Dwell: " << state.dwell_ms / 1000.0 << L" s"
           << L"\nWindow: " << state.valid_samples << L"/"
           << state.total_samples << L" (" << static_cast<int>(ratio)
           << L"%)   required " << config.RequiredValidSamples() << L"/"
           << config.WindowSampleCount();
    if (state.state == PresenceState::Cooldown) {
        status << L"   cooldown " << state.cooldown_remaining_ms / 1000.0
               << L" s";
    }

    RECT status_box{image_rect.left + 12, image_rect.top + 12,
                    std::min(image_rect.right - 12, image_rect.left + 650),
                    image_rect.top + 100};
    HBRUSH status_brush = CreateSolidBrush(RGB(20, 20, 20));
    FillRect(canvas, &status_box, status_brush);
    DeleteObject(status_brush);
    status_box.left += 10;
    status_box.top += 8;
    SetBkMode(canvas, TRANSPARENT);
    SetTextColor(canvas, RGB(245, 245, 245));
    SelectObject(canvas, context.font);
    const std::wstring status_text = status.str();
    DrawTextW(canvas, status_text.c_str(), -1, &status_box,
              DT_LEFT | DT_TOP | DT_WORDBREAK);

    if (state.state == PresenceState::Cooldown) {
        RECT triggered{image_rect.left, image_rect.bottom - 64,
                       image_rect.right, image_rect.bottom - 18};
        HBRUSH trigger_brush = CreateSolidBrush(RGB(20, 110, 45));
        FillRect(canvas, &triggered, trigger_brush);
        DeleteObject(trigger_brush);
        SetTextColor(canvas, RGB(255, 255, 255));
        DrawTextW(canvas, L"检测到用户在相框前驻足", -1, &triggered,
                  DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    }

    SetTextColor(canvas, RGB(25, 25, 25));
    RECT title{panel_left + 14, 5, width - 14, 28};
    DrawTextW(canvas, L"Link 2 detector parameters (live)", -1, &title,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE);

    BitBlt(target, 0, 0, width, height, canvas, 0, 0, SRCCOPY);
    SelectObject(canvas, old_bitmap);
    DeleteObject(bitmap);
    DeleteDC(canvas);
}

void CreateAllControls(HWND window, UiContext& context) {
    context.font = CreateFontW(-16, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                               DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                               CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                               DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
    context.derived_label = CreateWindowW(
        L"STATIC", L"", WS_CHILD | WS_VISIBLE, 0, 0, 1, 1,
        window, nullptr, nullptr, nullptr);
    SetControlFont(context.derived_label, context.font);

    AddControl(window, context, Parameter::PollHz, L"Polling frequency", 1, 20);
    AddControl(window, context, Parameter::MinHeadWidth, L"Minimum head width", 1, 30);
    AddControl(window, context, Parameter::MinHeadHeight, L"Minimum head height", 1, 40);
    AddControl(window, context, Parameter::FrameMargin, L"Complete-head margin", 0, 15);
    AddControl(window, context, Parameter::RoiLeft, L"ROI left", 0, 99);
    AddControl(window, context, Parameter::RoiRight, L"ROI right", 1, 100);
    AddControl(window, context, Parameter::RoiTop, L"ROI top", 0, 99);
    AddControl(window, context, Parameter::RoiBottom, L"ROI bottom", 1, 100);
    AddControl(window, context, Parameter::MaxCenterJump, L"Maximum center jump", 1, 100);
    AddControl(window, context, Parameter::MinAreaRatio, L"Minimum area ratio", 5, 100);
    AddControl(window, context, Parameter::MaxAreaRatio, L"Maximum area ratio", 100, 1000);
    AddControl(window, context, Parameter::WindowSeconds, L"Rolling window", 1, 20);
    AddControl(window, context, Parameter::ValidRatio, L"Required valid ratio", 10, 100);
    AddControl(window, context, Parameter::MinimumDwell, L"Minimum dwell", 5, 200);
    AddControl(window, context, Parameter::MissingTolerance, L"Missing tolerance", 0, 50);
    AddControl(window, context, Parameter::Cooldown, L"Cooldown", 0, 300);

    context.require_leave = CreateWindowW(
        L"BUTTON", L"Require confirmed leave before rearm",
        WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX, 0, 0, 1, 1,
        window, reinterpret_cast<HMENU>(kRequireLeaveId), nullptr, nullptr);
    SetControlFont(context.require_leave, context.font);
    SyncControls(context);
    LayoutControls(window, context);
}

LRESULT CALLBACK WindowProcedure(HWND window, UINT message, WPARAM wparam,
                                 LPARAM lparam) {
    UiContext* context = reinterpret_cast<UiContext*>(
        GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
        const auto* create = reinterpret_cast<CREATESTRUCTW*>(lparam);
        context = static_cast<UiContext*>(create->lpCreateParams);
        SetWindowLongPtrW(window, GWLP_USERDATA,
                          reinterpret_cast<LONG_PTR>(context));
    }

    switch (message) {
        case WM_CREATE:
            CreateAllControls(window, *context);
            SetTimer(window, kRefreshTimer, 33, nullptr);
            return 0;
        case WM_SIZE:
            if (context != nullptr) LayoutControls(window, *context);
            return 0;
        case WM_HSCROLL:
            if (context != nullptr) {
                const HWND slider = reinterpret_cast<HWND>(lparam);
                for (const auto& control : context->controls) {
                    if (control.slider == slider) {
                        DetectorConfig config = context->config->Get();
                        SetParameter(config, control.parameter,
                                     static_cast<int>(SendMessageW(
                                         slider, TBM_GETPOS, 0, 0)));
                        context->config->Set(config);
                        SyncControls(*context);
                        InvalidateRect(window, nullptr, FALSE);
                        break;
                    }
                }
            }
            return 0;
        case WM_COMMAND:
            if (context != nullptr && LOWORD(wparam) == kRequireLeaveId &&
                HIWORD(wparam) == BN_CLICKED) {
                DetectorConfig config = context->config->Get();
                config.require_leave_before_rearm =
                    SendMessageW(context->require_leave, BM_GETCHECK, 0, 0) ==
                    BST_CHECKED;
                context->config->Set(config);
            }
            return 0;
        case WM_TIMER:
            if (context != nullptr && !context->running->load()) {
                DestroyWindow(window);
                return 0;
            }
            InvalidateRect(window, nullptr, FALSE);
            return 0;
        case WM_KEYDOWN:
            if (wparam == VK_ESCAPE || wparam == 'Q') {
                SendMessageW(window, WM_CLOSE, 0, 0);
            }
            return 0;
        case WM_PAINT: {
            PAINTSTRUCT paint{};
            HDC dc = BeginPaint(window, &paint);
            if (context != nullptr) DrawDebugView(window, *context, dc);
            EndPaint(window, &paint);
            return 0;
        }
        case WM_ERASEBKGND:
            return 1;
        case WM_CTLCOLORSTATIC:
            SetBkColor(reinterpret_cast<HDC>(wparam), RGB(245, 246, 248));
            return reinterpret_cast<LRESULT>(GetSysColorBrush(COLOR_WINDOW));
        case WM_CLOSE:
            if (context != nullptr) context->running->store(false);
            DestroyWindow(window);
            return 0;
        case WM_DESTROY:
            KillTimer(window, kRefreshTimer);
            if (context != nullptr && context->font != nullptr) {
                DeleteObject(context->font);
                context->font = nullptr;
            }
            PostQuitMessage(0);
            return 0;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

}  // namespace

int RunDebugUi(VideoStreamCapture& video,
               DetectorConfigStore& config,
               DetectorStateStore& state,
               std::atomic<bool>& running) {
    INITCOMMONCONTROLSEX controls{};
    controls.dwSize = sizeof(controls);
    controls.dwICC = ICC_BAR_CLASSES;
    InitCommonControlsEx(&controls);

    HINSTANCE instance = GetModuleHandleW(nullptr);
    WNDCLASSEXW window_class{};
    window_class.cbSize = sizeof(window_class);
    window_class.style = CS_HREDRAW | CS_VREDRAW;
    window_class.lpfnWndProc = WindowProcedure;
    window_class.hInstance = instance;
    window_class.hCursor = LoadCursor(nullptr, IDC_ARROW);
    window_class.hbrBackground = GetSysColorBrush(COLOR_WINDOW);
    window_class.lpszClassName = kWindowClassName;
    if (RegisterClassExW(&window_class) == 0 &&
        GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
        return 1;
    }

    UiContext context;
    context.video = &video;
    context.config = &config;
    context.state = &state;
    context.running = &running;

    HWND window = CreateWindowExW(
        0, kWindowClassName, L"Insta360 Link 2 - Dwell Detector Debug UI",
        WS_OVERLAPPEDWINDOW | WS_VISIBLE, CW_USEDEFAULT, CW_USEDEFAULT,
        1500, 930, nullptr, nullptr, instance, &context);
    if (window == nullptr) {
        running.store(false);
        return 1;
    }

    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    running.store(false);
    return static_cast<int>(message.wParam);
}
