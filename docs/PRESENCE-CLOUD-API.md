# Link 2 驻足事件云端接口

本模块对接外部 Windows 上报器的 `presenceReport` 协议；不读取摄像头、不上传视频/截图/头部框/人脸身份，不把驻足解释为注视。部署与硬件验收结果由总控另行记录；以下实现测试不代表实体 Link 2 或真实云部署通过。

## owner 管理接口

所有调用均为 `POST /api`，JSON `{action,data}`，`Authorization: Bearer <当前家庭owner会话>`。只有有效 owner 可管理，不能指定其他家庭。

| action | data | 返回 |
| --- | --- | --- |
| `presenceSensorList` | `{}` | `{sensors,frames,eventTtlMs:15000}` |
| `presenceSensorIssue` | `{deviceId,targetFrameId}` | `{sensor,token,eventTtlMs:15000}` |
| `presenceSensorRotate` | `{deviceId}` | 同签发响应；原令牌立即失效 |
| `presenceSensorRevoke` | `{deviceId}` | `{ok:true}`；重复撤销安全 |

`targetFrameId` 必须使用列举结果 `frames[].id`（现有有效 frame session 的 ID），不能用相框登录 token 或邀请。`frames` 只包含本家庭有效相框，字段为 `id,name,online,expiresAt`；`online` 仅表示45秒内曾轮询，不等于物理设备正在观看。最多配置8个不同设备标识，撤销后的同标识可以重新签发、绑定新会话；需要换相框时先撤销后重新签发。

`sensor` 字段为 `deviceId,targetFrameId,createdAt,rotatedAt,revokedAt,expiresAt,active,targetAvailable`。`active` 表示传感器自身未撤销且未到期；还必须 `targetAvailable` 才能上报。列表永不返回令牌或摘要。签发/轮换响应仅这次返回 `token`；前端不得长期保存它。令牌格式为独立 `ps1.<家庭UUID>.<32字节随机数hex>`，服务端仅保存整个令牌的SHA-256摘要。传感器令牌不能访问普通家庭API，相框/owner会话不能用作传感器令牌。传感器有效期不超过目标相框的原会话有效期（现有配对最多7天）；退出、移除或到期后需要重新配对绑定。

将令牌通过私密渠道交给 Windows 端，由对方设置 `PRESENCE_SENSOR_TOKEN`，`PRESENCE_DEVICE_ID` 与 `deviceId` 保持一致；不要写入源码、Git、普通文档、截图或公开聊天。

## 上报和下发

`presenceReport` 在普通 `session()` 鉴权之前识别独立传感器令牌。

```json
{
  "action": "presenceReport",
  "data": {
    "version": 1,
    "eventId": "5e9fb7e1-609a-4c77-adf5-b43988403dcc",
    "source": "link2-windows",
    "deviceId": "living-room-link2",
    "type": "presence.dwell",
    "occurredAt": 1780000000000,
    "dwellMs": 4200,
    "headCount": 1
  }
}
```

示例时间仅展示结构，实际测试应填当前 Unix 毫秒时间。固定字段和值严格校验、拒绝任何附加字段；UUID规范化为小写，设备标识为1–64位字母/数字/点/下划线/短横线。时间和数值必须是安全整数，`dwellMs` 为0–86,400,000毫秒，`headCount` 为SDK原始0–10范围。新事件的设备时间必须晚于服务器当前时间减60秒，且不超过服务器当前时间加30秒。以服务端接收时间决定展示期限，客户端不能自行延长事件。

必须 `Content-Type: application/json`（可带 `charset=utf-8`）。整个JSON请求最大2,048字节，传感器前缀请求从读流前就限制体积；不影响现有图片/音频上传上限。

成功 HTTP **200**：`{"accepted":true,"eventId":"...","seq":18}`。同一有效令牌和同一事件的重试返回原 `seq`，不延长接收或过期时间；同一ID改变内容或设备返回409。无效/撤销/过期令牌或目标相框返回401，格式或时钟错误400，过大413，频率超限429。需要持续同步Windows系统时钟。

只在绑定家庭、绑定frame session的 `state` 中返回：

```json
{"presenceEvent":{"seq":18,"eventId":"...","type":"presence.dwell","receivedAt":1780000000100,"expiresAt":1780000015100}}
```

家人/owner、其他家庭/相框、到期/撤销事件均省略 `presenceEvent`。当前相框收到多个事件时只下发序号最大的未过期事件；每次轮询不会消耗事件，由前端持久去重并判断页面/录音/音频/AI等状态。传感器仅触发邀请，老人确认后才打开固定照片的 `MemoryAI.open(messageId)`。

## 持久一致性、限流和清理边界

复用现有 `memory_demo_records`，不新增集合、权限、Timer、WebSocket或SSE。每家庭只有一个 `kind:presence` CAS文档：设备摘要、单调递增 `seq`、有界短期事件与预算。鉴权的令牌代际、事件去重和序号增加在**同一次 CloudStore.mutate CAS**中提交，多实例重试不能重复生成序号。写后重新核验令牌和目标会话，轮换/撤销立即取消下发，并保留短期去重摘要避免旧事件借新令牌重放。

每设备每分钟最多30个新事件/120个有效请求（含重试），每家庭最多60个新事件/240个有效请求，限流在CAS文档中跨实例执行。最多128条短期记录，达到容量拒绝新事件，不通过驱逐未到期记录破坏幂等。预算数组最多包含家庭与当前设备项；轮换移除旧摘要预算。CloudBase的更新会展开嵌套对象，因此事件、传感器、预算都使用整体替换的数组，清空时明确写入 `[]`。

**15秒是下发有效期，不是数据库物理删除SLA。** 到期事件不再返回；清理时立即移除其可读 `eventId`、目标frame ID和接收时间，仅保留重试所需的事件/内容/令牌摘要、`seq`、去重到期时间。去重通常保留接收后60秒；若客户端时钟领先，保留到 `max(receivedAt,occurredAt)+60秒`，最多90秒，确保清理后原事件已过时间校验，不能再次生成邀请。原始驻足时长、头部数量和设备触发时间不持久化。

每次相关读取/写入清理过期项；接收后使用非阻塞定时器安排最近的15秒/去重/预算清理；服务启动以及后续API流量每分钟机会扫描所有presence文档。无到期项不写库。清理临时故障不阻断其他家庭/AI操作，最多每分钟重试；presence本身仍执行权限和有效期校验。云函数冻结、停止且长期无后续流量时，最后有界记录可能残留到下一次启动或请求，**不能承诺静默期间硬删除**。不会累积无限行为历史。如后续要求硬物理删除SLA，需单独设计并授权云端生命周期清理。

服务端最小诊断使用 `[presence]`，仅输出 `status:accepted|duplicate,eventId,seq`，可在云函数日志按eventId检索；不包含家庭、设备、照片、头像、聊天、原始测量值或令牌。日志保留期限沿用部署环境的日志设置，不把日志解释为设备连续行为记录。

## 本轮后端证据

`test/presence-cloud.test.js` 覆盖真实本地Node HTTP鉴权/字段/状态隔离，LocalStore重启，重复重试、到期、跨家庭/目标撤销、token轮换交错、持久限流和清理故障隔离。生产 `CloudStore.mutate` 使用替代数据库传输并发制造CAS冲突验证多实例序号/幂等；真实CloudBase SDK离线序列化验证空数组确实输出 `$set`。这些分别是本地HTTP、存储并发替身和SDK离线证据，不是实际CloudBase网络/硬件/browser验证。

后端定向回归命令：

```powershell
node --test test/presence-cloud.test.js test/family-state.test.js test/integration.test.js test/accounts.test.js test/cloud-sdk.test.js
```

本次45项通过、0失败、0跳过（包含14项新增presence测试）。真实部署、绑定目标相框、私密令牌交付和Windows→云→iPad联调由总控在后续验收中记录。
