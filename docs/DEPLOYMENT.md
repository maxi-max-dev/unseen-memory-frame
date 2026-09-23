# 在自己的环境部署

先完成 README 的本地启动。部署只使用自己控制的 CloudBase 环境，不需要原项目的账号、角色或公网地址。

1. 在自己的腾讯云账号中准备 CloudBase 环境、云数据库与云存储。创建 `memory_demo_records` 集合，数据库和存储的客户端权限均设为 `ADMINONLY`，所有客户端经本应用 API 访问。
2. 准备仅用于本应用的云函数执行角色，授予该环境所需数据库和存储权限；按实际使用情况另配 ASR/模型权限。不要复制其他项目的角色或密钥。
3. 将 `cloudbaserc.example.json` 复制成被 Git 忽略的 `cloudbaserc.local.json`，填写自己的环境 ID、执行角色和随机开通码。配置 Node HTTP 函数，内存 512 MB、超时 150 秒、端口 9000、网关路径 `/`；`MEMORY_CLOUDBASE_ENV` 必须与目标环境相同。
4. 用自己的账号完成 CloudBase CLI 登录。显式指定目标环境再部署：

```sh
node node_modules/@cloudbase/cli/bin/tcb login
node scripts/deploy.mjs --env YOUR_ACTUAL_ENVIRONMENT_ID
```

脚本拒绝示例占位符、缺失开通码、环境不一致和未知参数；需要覆盖自己的已有函数时显式增加 `--update`。仅打包 `server`，本地数据、测试资料与 Git 不会部署。脚本不会创建集合、角色、套餐或购买服务。

部署后检查 `/health`，从 `/family` 自行创建演示家庭，复用这一家庭验证邀请、相框、照片和状态；不要反复用注册测试消耗家庭配额。生产数据与测试数据分开，默认每家庭的条数/媒体大小限制见代码。保持原有 HTTPS 同源 API，不通过开放数据库规则解决鉴权问题。

## 可选 AI

在云函数私有环境变量中配置，不能写入前端。CloudBase 内置文字模型需要填 `AI_MODEL` 并在自己的环境开通可用模型；兼容接口同时填 `AI_MODEL`、`AI_BASE_URL`、`AI_API_KEY`。照片视觉用独立的 `AI_VISION_MODEL`、`AI_VISION_BASE_URL`、`AI_VISION_API_KEY`，模型需支持图像。ASR 可用兼容转写接口，或配置云函数自己的临时权限。朗读依赖浏览器能力，不等同于供应商实时语音。

`.env.example` 用于本机手动配置；Node 不会自动读取 `.env`，使用 `node --env-file=.env server/server.js` 显式加载。不要在本机试跑时继承其他项目的云环境变量。

## 可选实时语音

保持 `AI_REALTIME_ENABLED=0` 直到以下流程真实通过：

1. 执行 `node scripts/prepare-trtc.mjs`，从官方 npm 准备 `trtc-sdk-v5@5.19.2` 的浏览器模块；该固定模块随后随自己的云函数部署。
2. 在自己的 TRTC 应用确认服务权益与费用、房间权限、SDK App ID、签名密钥、服务端 API 凭据。
3. 配置 `AI_REALTIME_PROVIDER=tencent-trtc`、`AI_REALTIME_TRTC_*`。`AI_REALTIME_LLM_JSON` 需要 `{ "LLMType": "openai", "Model": "你的流式模型", "APIKey": "私有凭据", "APIUrl": "https://你的接口/chat/completions" }`；接口需支持 TRTC 实际使用的流式请求。`AI_REALTIME_TTS_JSON` 需要 `{ "TTSType": "flow", "Model": "flow_02_turbo", "VoiceId": "已开通音色" }`。
4. 先执行 `node scripts/check-trtc-readiness.mjs` 查看用法并做离线配置检查，再由自己的应用进行真实连通、挂断、迟到响应和清理验收。存在接口不等于开通成功；文字 CloudBase 模型也不自动成为 TRTC 可调用的流式公网端点。

## 传感器

家人管理页签发只绑定当前家庭的传感器令牌，再把自己的 HTTPS `/api` 地址和令牌交给 Windows 上报器。令牌是私有访问能力，不放进 Git 或截图。按同版本 presence 协议做设备上报、重复上报、过期和跨家庭拒绝验证，最后在相框上人工确认邀请。没有确认不自动调用 AI 或麦克风。
