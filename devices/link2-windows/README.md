# Link 2 Windows 驻足设备端

这是 **unseen 记忆相框** 的 Windows 设备端，接入现有相框服务的 `POST /api` / `presenceReport`，不包含另一套网页或后端。Node 包装器启动一个 Link 2 检测进程，只转发 `presence.dwell` 小事件；相框轮询收到后显示邀请，老人确认后才进入 AI。摄像头画面和头部框仅用于电脑本地调试窗口，不上传，也不判断身份或眼神注视。

源码来源与修改范围见 [UPSTREAM.md](UPSTREAM.md)。本目录不附厂商 SDK、预编译 EXE/DLL、Node、私有令牌或家庭数据。

## 先绑定家庭和相框

1. 在家人端以家庭创建者登录，进入设置 → 管理相框驻足邀请。
2. 选择**已经配对的具体老人相框**，设备标识建议 `living-room-link2`，签发令牌。
3. 将一次性显示的 `ps1` 传感器令牌通过私密渠道交给这台 Windows 电脑。不要使用 owner/相框登录会话、账号密码、开通码或旧 MVP 全局 token。
4. 把配置保存在仓库之外，例如 `C:\Private\presence.private.json`，限制为本人及需要运行设备的账户可读。

私有 JSON 的结构如下，示例占位符需替换后才能运行：

```json
{
  "endpoint": "https://example.invalid/api",
  "deviceId": "living-room-link2",
  "sensorToken": "填入当前相框设置签发的独立ps1令牌",
  "demoPath": "../camera/link2_dwell_demo.exe"
}
```

`endpoint`、`deviceId`、`sensorToken` 必填，`demoPath` 可省略。`demoPath` 相对**配置文件所在目录**解释。不自动寻找 `.presence-mvp-token`、旧 `.env` 或相邻预览目录；已有进程环境变量仍受支持。私有配置明确指定后，其令牌和设备标识作为一组使用，不与旧环境中的值混合。

目标相框退出、移除或会话到期后需要重新配对并重新绑定。轮换令牌后先停止旧上报器，更新私有文件，再启动；原令牌不能继续使用。当前服务会话最长7天，令牌不超过所绑相框的有效期。

## 启动已有设备程序

要求 Windows x64、Node.js 20及以上，以及可信来源的 `link2_dwell_demo.exe` 和与其配套的 `UVCCamera.dll`。二者放在同一目录。若运行私有交付中的原预编译程序，其设备选择逻辑仍是旧版，**只能连接一台 Link 2，勿同时接入多台 Link 2**；本次源码构建只统计名称匹配 Link 2 的候选，恰好一台才选择其 `display_name`，没有匹配或多个匹配时拒绝。笔记本内置等非 Link 2 摄像头不造成选择歧义；尚未实现同机多 Link 2 选择支持。

先关闭可能占用摄像头的 Link Controller、相机、会议或 OBS 应用。由上报器启动检测程序，不要再手动打开第二份。启动会显示本地摄像头调试窗口；本次源码整合没有实际打开摄像头验收。

在本目录执行：

```powershell
# 仅检查配置格式，无联网、无摄像头；不代表云端token/目标已验证。
.\start-cloud-uploader.ps1 -ConfigPath 'C:\Private\presence.private.json' -NodePath 'C:\Tools\node.exe' -CheckConfig

# 正式运行。若Node已加入PATH，可省略-NodePath。
.\start-cloud-uploader.ps1 -ConfigPath 'C:\Private\presence.private.json' -DemoPath 'C:\Private\camera\link2_dwell_demo.exe' -NodePath 'C:\Tools\node.exe'
```

PowerShell 的 `-ConfigPath`、`-DemoPath`、`-NodePath` 相对**启动脚本所在目录**解析，因此私有便携包可以使用 `..\private-access\presence.private.json`、`..\camera\link2_dwell_demo.exe`、`..\runtime\node.exe`，不依赖当前工作目录。Node 直接命令的 `--config` / `--demo` 使用通常的当前目录规则。

可以用 `-Endpoint` / `--endpoint` 明确覆盖地址。地址必须以 `/api` 结尾，不允许 userinfo、查询参数或 fragment；远端必须 HTTPS，HTTP 只允许 localhost/127.0.0.1/IPv6回环测试。不要把 token 放 URL 或命令行参数。默认地址是上述当前相框公网，但所有本目录测试只访问新建本地服务。

未指定私有配置时，读取已有的 `PRESENCE_SENSOR_TOKEN`、`PRESENCE_DEVICE_ID`、`PRESENCE_ENDPOINT` 环境变量；设备标识默认 `living-room-link2`。启动器不读取环境文件本身。运行时不会把 `PRESENCE_*` 环境变量传给检测 EXE。

## 无摄像头、无网络检查

```powershell
$sample = @{type='presence.dwell';timestamp=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();dwellMs=4200;headCount=1} | ConvertTo-Json -Compress
('EVENT:' + $sample) | .\start-cloud-uploader.ps1 -Stdin -Once -DryRun
```

`-DryRun` 只解析并输出这条事件的协议JSON；配合 `-Stdin` 不会启动相机。若环境中有旧 MVP token，先在测试进程中清除它，或使用有效当前配置；上报器不会悄悄接受旧鉴权方式。不要使用固定的历史时间戳测试实时上传。

正常日志是 `captured presence.dwell eventId=…`、`uploaded … status=200 attempt=…`。这里只输出最小事件ID、状态和尝试次数；不会显示 token、原始HTTP响应、摄像头原始stdout/stderr。HTTP 401/403会停止设备进程，需核对绑定或轮换；其他失败可在新事件到来时继续尝试。关闭调试窗口或按 Ctrl+C 停止。

## 队列、重试和退出行为

- 每次事件生成一个UUID，重试保持原ID。网络故障、408/425/429和5xx最多尝试5次，退避1、2、4、8秒；其他4xx不重试。单请求默认5秒超时。
- 设备只保留一个上传中的事件和一个最新待传事件；后来的事件替换尚未处理的旧项。不落盘排队，不在断网恢复后补发整段活动历史。
- 本地触发超过30秒或设备时间超前超过30秒就忽略；同一事件从首次接收起总处理时间最多30秒，可能早于5次尝试结束。这个设备上传期限与**服务端接收后15秒邀请有效期**不同。
- Ctrl+C/SIGTERM取消当前HTTP请求与退避、丢弃待传事件并结束检测子进程。`--once`/`-Once` 最多处理第一个新鲜有效事件，完成或失败即停止输入/子进程，stdin无须等到EOF。
- 退出码：0正常；1启动/配置/输入或设备进程异常；2上传失败或处理期间过期；3单次模式未取得可处理事件；130用户取消。历史失败不会因后续成功改写成0。

## 从源码构建检测程序

安装 Visual Studio 2022 C++ Build Tools 与 CMake 3.20+，从厂商取得官方 Windows Link SDK。本仓库不下载或重分发SDK。可指定官方压缩包，或解压后包含 `x64` 的目录：

```powershell
.\build.ps1 -SdkArchive 'C:\SDK\UVCCamera_win.zip'
# 或
.\build.ps1 -SdkRoot 'C:\SDK\UVCCamera_win'
```

要求 `x64/include/uvc_camera.h`、`x64/lib/UVCCamera.lib`、`x64/bin/UVCCamera.dll`。脚本从PATH或 `vswhere` 找 CMake，不再假设G盘安装位置；可用 `-CMakePath`、`-Generator` 指定已安装工具，默认生成器是 `Visual Studio 17 2022`。相对SDK/输出路径按脚本目录解释。

默认输出 `build/Release/link2_dwell_demo.exe`，DLL复制到同目录；SDK压缩包按SHA-256解压至构建目录，换包不会误用上次头文件。切换SDK压缩包/解压目录模式时使用新的 `-BuildDir`，脚本不会删除旧目录。

原有检测默认5Hz采样、4秒窗口、80%有效样本、最少4秒驻足、0.8秒短暂丢失容忍、30秒冷却且确认离开后重新布防。调试窗口可调整阈值。这里只保留上游驻足策略及本地图像调试，不扩展识人、注视或多摄像头能力。

## 验证范围

从仓库根目录运行：

```powershell
node --test devices/link2-windows/test/*.test.cjs
```

包含上游6项协议测试（实时上传样例改用当前时间）、取消与重试边界、队列/时效/隐私检查、真实Node CLI、PowerShell配置/构建缺项检查，以及 **当前相框后端+全新临时LocalStore+真实本地HTTP** 的绑定、丢响应重试幂等、目标隔离与撤销闭环。不使用云端、既有家庭或包内快照。

本次没有SDK完整编译、实体摄像头、现场驻足或Windows→云→平板实机证据；缺SDK/CMake时构建脚本会解释缺项，不把预检当作编译完成。
