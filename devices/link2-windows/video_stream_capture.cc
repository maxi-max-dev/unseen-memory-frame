#include "video_stream_capture.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <dshow.h>
#include <dvdmedia.h>

#include <atomic>
#include <cstring>
#include <iostream>
#include <mutex>

namespace {

// Sample Grabber was removed from recent Windows SDK headers, but the standard
// DirectShow filter remains present in quartz.dll. These are its published COM
// interfaces and class IDs.
MIDL_INTERFACE("0579154A-2B53-4994-B0D0-E773148EFF85")
ISampleGrabberCB : public IUnknown {
public:
    virtual HRESULT STDMETHODCALLTYPE SampleCB(double sample_time,
                                               IMediaSample* sample) = 0;
    virtual HRESULT STDMETHODCALLTYPE BufferCB(double sample_time,
                                               BYTE* buffer,
                                               long buffer_length) = 0;
};

MIDL_INTERFACE("6B652FFF-11FE-4FCE-92AD-0266B5D7C78F")
ISampleGrabber : public IUnknown {
public:
    virtual HRESULT STDMETHODCALLTYPE SetOneShot(BOOL one_shot) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetMediaType(const AM_MEDIA_TYPE* type) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetConnectedMediaType(AM_MEDIA_TYPE* type) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetBufferSamples(BOOL buffer_them) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetCurrentBuffer(long* buffer_size,
                                                       long* buffer) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetCurrentSample(IMediaSample** sample) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetCallback(ISampleGrabberCB* callback,
                                                  long method) = 0;
};

const GUID kClsidSampleGrabber = {
    0xc1f400a0, 0x3f08, 0x11d3,
    {0x9f, 0x0b, 0x00, 0x60, 0x08, 0x03, 0x9e, 0x37}};
const GUID kClsidNullRenderer = {
    0xc1f400a4, 0x3f08, 0x11d3,
    {0x9f, 0x0b, 0x00, 0x60, 0x08, 0x03, 0x9e, 0x37}};

template <typename T>
void SafeRelease(T*& object) {
    if (object != nullptr) {
        object->Release();
        object = nullptr;
    }
}

void FreeMediaType(AM_MEDIA_TYPE& type) {
    if (type.cbFormat != 0) {
        CoTaskMemFree(type.pbFormat);
        type.cbFormat = 0;
        type.pbFormat = nullptr;
    }
    SafeRelease(type.pUnk);
}

class FrameReceiver {
public:
    virtual ~FrameReceiver() = default;
    virtual void Receive(BYTE* buffer, long buffer_length) = 0;
};

class SampleGrabberCallback final : public ISampleGrabberCB {
public:
    explicit SampleGrabberCallback(FrameReceiver* receiver)
        : receiver_(receiver) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override {
        if (object == nullptr) {
            return E_POINTER;
        }
        if (iid == IID_IUnknown || iid == __uuidof(ISampleGrabberCB)) {
            *object = static_cast<ISampleGrabberCB*>(this);
            AddRef();
            return S_OK;
        }
        *object = nullptr;
        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override {
        return ++references_;
    }

    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG remaining = --references_;
        if (remaining == 0) {
            delete this;
        }
        return remaining;
    }

    HRESULT STDMETHODCALLTYPE SampleCB(double, IMediaSample*) override {
        return E_NOTIMPL;
    }

    HRESULT STDMETHODCALLTYPE BufferCB(double, BYTE* buffer,
                                       long buffer_length) override {
        if (receiver_ != nullptr && buffer != nullptr && buffer_length > 0) {
            receiver_->Receive(buffer, buffer_length);
        }
        return S_OK;
    }

private:
    std::atomic<ULONG> references_{1};
    FrameReceiver* receiver_ = nullptr;
};

}  // namespace

class VideoStreamCapture::Impl : public FrameReceiver {
public:
    ~Impl() override {
        Stop();
    }

    bool Start(const std::string& display_name) {
        Stop();

        HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        if (SUCCEEDED(hr)) {
            com_initialized_ = true;
        } else if (hr != RPC_E_CHANGED_MODE) {
            return Fail("CoInitializeEx", hr);
        }

        ICaptureGraphBuilder2* capture_builder = nullptr;
        IBindCtx* bind_context = nullptr;
        IMoniker* moniker = nullptr;
        IBaseFilter* source = nullptr;
        IBaseFilter* sample_filter = nullptr;
        IBaseFilter* null_renderer = nullptr;

        hr = CoCreateInstance(CLSID_FilterGraph, nullptr, CLSCTX_INPROC_SERVER,
                              IID_IGraphBuilder,
                              reinterpret_cast<void**>(&graph_));
        if (SUCCEEDED(hr)) {
            hr = CoCreateInstance(CLSID_CaptureGraphBuilder2, nullptr,
                                  CLSCTX_INPROC_SERVER,
                                  IID_ICaptureGraphBuilder2,
                                  reinterpret_cast<void**>(&capture_builder));
        }
        if (SUCCEEDED(hr)) {
            hr = capture_builder->SetFiltergraph(graph_);
        }

        if (SUCCEEDED(hr)) {
            hr = CreateBindCtx(0, &bind_context);
        }
        ULONG eaten = 0;
        const std::wstring wide_name(display_name.begin(), display_name.end());
        if (SUCCEEDED(hr)) {
            hr = MkParseDisplayName(bind_context,
                                    const_cast<wchar_t*>(wide_name.c_str()),
                                    &eaten, &moniker);
        }
        if (SUCCEEDED(hr)) {
            hr = moniker->BindToObject(nullptr, nullptr, IID_IBaseFilter,
                                       reinterpret_cast<void**>(&source));
        }
        if (SUCCEEDED(hr)) {
            hr = graph_->AddFilter(source, L"Insta360 Link 2");
        }

        if (SUCCEEDED(hr)) {
            hr = CoCreateInstance(kClsidSampleGrabber, nullptr,
                                  CLSCTX_INPROC_SERVER, IID_IBaseFilter,
                                  reinterpret_cast<void**>(&sample_filter));
        }
        if (SUCCEEDED(hr)) {
            hr = sample_filter->QueryInterface(__uuidof(ISampleGrabber),
                                               reinterpret_cast<void**>(
                                                   &sample_grabber_));
        }
        if (SUCCEEDED(hr)) {
            hr = graph_->AddFilter(sample_filter, L"Frame Grabber");
        }

        AM_MEDIA_TYPE requested{};
        requested.majortype = MEDIATYPE_Video;
        requested.subtype = MEDIASUBTYPE_RGB24;
        requested.formattype = FORMAT_VideoInfo;
        if (SUCCEEDED(hr)) {
            hr = sample_grabber_->SetMediaType(&requested);
        }

        if (SUCCEEDED(hr)) {
            hr = CoCreateInstance(kClsidNullRenderer, nullptr,
                                  CLSCTX_INPROC_SERVER, IID_IBaseFilter,
                                  reinterpret_cast<void**>(&null_renderer));
        }
        if (SUCCEEDED(hr)) {
            hr = graph_->AddFilter(null_renderer, L"Null Renderer");
        }
        if (SUCCEEDED(hr)) {
            hr = capture_builder->RenderStream(&PIN_CATEGORY_CAPTURE,
                                               &MEDIATYPE_Video, source,
                                               sample_filter, null_renderer);
        }

        AM_MEDIA_TYPE connected{};
        if (SUCCEEDED(hr)) {
            hr = sample_grabber_->GetConnectedMediaType(&connected);
        }
        if (SUCCEEDED(hr)) {
            hr = ReadConnectedFormat(connected);
        }
        FreeMediaType(connected);

        if (SUCCEEDED(hr)) {
            callback_ = new SampleGrabberCallback(this);
            hr = sample_grabber_->SetOneShot(FALSE);
        }
        if (SUCCEEDED(hr)) {
            hr = sample_grabber_->SetBufferSamples(FALSE);
        }
        if (SUCCEEDED(hr)) {
            hr = sample_grabber_->SetCallback(callback_, 1);
        }
        if (SUCCEEDED(hr)) {
            hr = graph_->QueryInterface(IID_IMediaControl,
                                        reinterpret_cast<void**>(
                                            &media_control_));
        }
        if (SUCCEEDED(hr)) {
            hr = media_control_->Run();
        }

        SafeRelease(capture_builder);
        SafeRelease(bind_context);
        SafeRelease(moniker);
        SafeRelease(source);
        SafeRelease(sample_filter);
        SafeRelease(null_renderer);

        if (FAILED(hr)) {
            return Fail("Build/start Link 2 RGB capture graph", hr);
        }

        running_ = true;
        std::cout << "Activated Link 2 UVC stream and frame grabber: "
                  << width_ << "x" << height_ << " RGB24" << std::endl;
        return true;
    }

    void Stop() {
        if (sample_grabber_ != nullptr) {
            sample_grabber_->SetCallback(nullptr, 1);
        }
        if (media_control_ != nullptr && running_) {
            media_control_->Stop();
        }
        running_ = false;
        SafeRelease(sample_grabber_);
        SafeRelease(media_control_);
        SafeRelease(graph_);
        if (callback_ != nullptr) {
            callback_->Release();
            callback_ = nullptr;
        }
        if (com_initialized_) {
            CoUninitialize();
            com_initialized_ = false;
        }
        std::lock_guard<std::mutex> lock(frame_mutex_);
        latest_.bgr24.clear();
        latest_.width = 0;
        latest_.height = 0;
    }

    bool CopyLatestFrame(VideoFrame& frame) const {
        std::lock_guard<std::mutex> lock(frame_mutex_);
        if (latest_.bgr24.empty()) {
            return false;
        }
        frame = latest_;
        return true;
    }

    void Receive(BYTE* buffer, long buffer_length) override {
        if (buffer_length <= 0 || width_ <= 0 || height_ <= 0) {
            return;
        }
        std::lock_guard<std::mutex> lock(frame_mutex_);
        latest_.width = width_;
        latest_.height = height_;
        latest_.bottom_up = bottom_up_;
        latest_.bgr24.assign(buffer, buffer + buffer_length);
    }

private:
    HRESULT ReadConnectedFormat(const AM_MEDIA_TYPE& type) {
        const BITMAPINFOHEADER* bitmap = nullptr;
        if (type.formattype == FORMAT_VideoInfo &&
            type.cbFormat >= sizeof(VIDEOINFOHEADER)) {
            const auto* info = reinterpret_cast<const VIDEOINFOHEADER*>(
                type.pbFormat);
            bitmap = &info->bmiHeader;
        } else if (type.formattype == FORMAT_VideoInfo2 &&
                   type.cbFormat >= sizeof(VIDEOINFOHEADER2)) {
            const auto* info = reinterpret_cast<const VIDEOINFOHEADER2*>(
                type.pbFormat);
            bitmap = &info->bmiHeader;
        }
        if (bitmap == nullptr || bitmap->biBitCount != 24) {
            return VFW_E_INVALIDMEDIATYPE;
        }
        width_ = std::abs(bitmap->biWidth);
        height_ = std::abs(bitmap->biHeight);
        bottom_up_ = bitmap->biHeight > 0;
        return (width_ > 0 && height_ > 0) ? S_OK : E_FAIL;
    }

    bool Fail(const char* operation, HRESULT hr) {
        std::cerr << operation << " failed, HRESULT=0x" << std::hex
                  << static_cast<unsigned long>(hr) << std::dec << std::endl;
        Stop();
        return false;
    }

    bool com_initialized_ = false;
    bool running_ = false;
    int width_ = 0;
    int height_ = 0;
    bool bottom_up_ = true;

    IGraphBuilder* graph_ = nullptr;
    IMediaControl* media_control_ = nullptr;
    ISampleGrabber* sample_grabber_ = nullptr;
    SampleGrabberCallback* callback_ = nullptr;

    mutable std::mutex frame_mutex_;
    VideoFrame latest_;
};

VideoStreamCapture::VideoStreamCapture() : impl_(new Impl) {}

VideoStreamCapture::~VideoStreamCapture() = default;

bool VideoStreamCapture::Start(const std::string& display_name) {
    return impl_->Start(display_name);
}

void VideoStreamCapture::Stop() {
    impl_->Stop();
}

bool VideoStreamCapture::CopyLatestFrame(VideoFrame& frame) const {
    return impl_->CopyLatestFrame(frame);
}
