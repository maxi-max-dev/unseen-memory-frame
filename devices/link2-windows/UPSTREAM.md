# 来源与整合范围

来源：用户提供的 `前后端项目包-MVP.rar` 中 `link2_dwell_demo/` 文本源码，2026-09-24整合到当前相框主线。压缩包SHA-256：

```text
c2d2bd4ca73fd130212fffcf4f389543d4f9ebb6e52a20e6fe3aa0edd2818602
```

保留原作者检测策略、DirectShow单进程视频通道及Win32调试UI。`main.cc` 仅增加多个匹配Link2设备的歧义拒绝、移除非Link2回退、及时刷新事件输出；非Link2摄像头不计入候选，唯一匹配的Link2按其 `display_name` 打开。`CMakeLists.txt` / `build.ps1` 改为显式SDK位置和可发现的Windows工具链。包装器沿用事件协议、默认公网端点和UUID重试模型，修复停止/单次退出、有限队列与新鲜度、日志秘密回显、私有配置与当前 `ps1` 令牌校验。原6项测试保留，其中上传测试时间戳改为实时值。

未引入源包中的旧MVP网页/后端、旧本地启动器、`.presence-mvp-token`、`.git`、数据、依赖、Node、EXE/DLL、SDK压缩包或厂商文件。厂商SDK及二进制仍需依照其自身授权取得；本文件不改变上游或SDK的权利归属，也不为未附独立许可的提供者源码虚构许可证。

原始文本文件的SHA-256，供后续核对来源（不是当前修改后文件摘要）：

| 上游路径 | SHA-256 |
| --- | --- |
| `presence_uploader.cjs` | `b5174cde2bca6ad1a9c4fa61ea7d77fe8370d18093544520cbd322dba5b3579d` |
| `start-cloud-uploader.ps1` | `be34bc8bcbc8592f09fcd963fa3c2f91537037ac34d6c96d6c7676ce5f8079d9` |
| `build.ps1` | `3b8b287041668df7b1d7c6e86816856544112d6b196289cb785f4c02ce7369b0` |
| `CMakeLists.txt` | `58778392744519fc9982325cb6d61b44e76c6e6ce5e9ca7516f86f0dd70ce9c7` |
| `main.cc` | `ac2456d1810f6a744d3298edbf80f29313d74b1d39055aa7fe97037e768f2545` |
| `detector_types.h` | `72211402f3050bb1ca5e197e0f10d47e1ac8fd5fe206eaa78854362e4087c2f4` |
| `debug_ui.cc` | `501415261490fc61cddd3ab17d4fc95ddd3910968c24098408e33d5141730fc72` |
| `debug_ui.h` | `9c3450246798d9db64554ee1fd0b166aeb1c845b7eb894cce6e9a973afef3669` |
| `video_stream_capture.cc` | `19c577c94d9e4b12b4aa21e83b46077495714ea33a1cec77488b74255bc5214b` |
| `video_stream_capture.h` | `db252aa2d8d45dd99d31e280105f2ccaf9ba3eea05ef7dbdeec6f81571e9c2b9` |
| `test/presence_uploader.test.cjs` | `2fcb95360971a9f54085cdb79d1f962ef160639c8cbdb2e37f2fcc34c885da30` |
