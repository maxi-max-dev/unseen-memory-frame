# 第三方与素材说明

- **PlayCanvas 2.22.3**：随仓库分发的浏览器模块，MIT 许可原文位于 `server/public/vendor/playcanvas-LICENSE.txt`。来源：[PlayCanvas Engine](https://github.com/playcanvas/engine)。
- **Unseen Sans / Source Han Sans SC 2.005R**：基于 Adobe 官方思源黑体生成的重命名字体分片，SIL Open Font License 1.1 原文位于 `server/public/assets/fonts/unseen-sans/LICENSE.txt`。上游版本、SHA256 和分片清单位于同目录 `manifest.json`，生成脚本为 `scripts/build-fonts.py`。来源：[Adobe Source Han Sans](https://github.com/adobe-fonts/source-han-sans)。
- **TRTC Web 5.19.2**：npm 元数据声明 ISC，但原发布包没有独立 LICENSE 文件。公开仓库不附其 SDK 二进制；`scripts/prepare-trtc.mjs` 从 [官方 npm 版本](https://www.npmjs.com/package/trtc-sdk-v5/v/5.19.2) 获取固定包并验证 SHA512 后提取浏览器模块，保留模块原始注释与附带元数据。SDK 与腾讯云服务使用条件应由部署者在启用前确认，源包不是本项目拥有的作品。
- **Node 依赖**：CloudBase CLI/SDK、qrcode、腾讯 ASR/TRTC 服务端 SDK、tls-sig-api-v2 及其传递依赖由两个 `pnpm-lock.yaml` 锁定；安装时获取上游包，不在源码仓库复制 `node_modules`。各包许可证仍适用。
- **演示图片**：原演示 JPG 来源未能在可公开资料中核实，全部排除。仓库图片由 `scripts/generate-demo-assets.mjs` 的几何绘图代码生成，不含外部摄影作品、真人肖像或家庭内容；可运行脚本逐字节重建。
- **用户内容**：照片、录音、故事、3D 模型与影石分享链接由使用者提供，不附在公开包内。空间导入测试中的分享标识是人为替换后的 fixture，不代表公开可用的真实模型。

本仓库没有为原创应用代码添加开源许可证。公开展示不改变第三方著作权，也不自动授予对原创代码的再许可权。
