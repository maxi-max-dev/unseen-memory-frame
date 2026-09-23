'use strict';
// Shared URL grammar: the browser offers import only for the server's exact route.
(function (root) {
  function parseShare(value) {
    if (typeof value !== 'string' || value.length > 8192 || /[\s\\]/.test(value)) return null;
    let url; try { url = new URL(value); } catch { return null; }
    const match = /^\/3dspace\/detail\/(GS3DC[0-9a-fA-F]{32})\/?$/.exec(url.pathname);
    if (url.protocol !== 'https:' || url.hostname !== 'app.insta360.com' || url.port || url.username || url.password || url.hash || !match) return null;
    return { url: 'https://app.insta360.com/3dspace/detail/' + match[1], scene: match[1] };
  }
  function inspect(value) {
    const input = typeof value === 'string' ? value.trim() : '';
    if (!input) return { kind: 'empty', url: '', hint: '粘贴影石时光舱的作品网页链接，也可以粘贴含链接的分享文字。' };
    if (input.length > 2000) return { kind: 'invalid', hint: '分享文字太长，请只复制作品的网页链接。' };
    const share = parseShare(input);
    if (share) return { kind: 'share', ...share, hint: '已识别影石时光舱作品。寄出后自动导入，完成后家人和相框都可观看。' };
    // Extract one complete URL only; never infer an ID or repair a different host.
    const urls = input.match(/https?:\/\/[^\s<>"'，。！？；、）】》]+/gi) || [];
    if (urls.length === 1 && urls[0] !== input && !/^https?:\/\//i.test(input)) {
      const extracted = parseShare(urls[0]);
      if (extracted) return { kind: 'share', ...extracted, hint: '已从分享文字中识别作品链接。寄出后自动导入空间。' };
    }
    let url;
    try { url = new URL(input); } catch { /* Not a standalone URL. */ }
    if (!url || url.protocol !== 'https:' || url.username || url.password || /[\s\\]/.test(input)) {
      return { kind: 'invalid', hint: urls.length > 1 ? '包含多个链接，请只粘贴一个影石时光舱作品链接。' : '请复制完整的 HTTPS 作品网页链接，或含单个作品链接的分享文字。' };
    }
    if (/\.(mp4|mov|insv|webm)$/i.test(url.pathname)) return { kind: 'video', url: input, hint: '这是视频链接，不能导入为空间。请在影石时光舱中选择作品的“网页链接分享”；相框暂不支持视频重建。' };
    if (/\.(sog|zip|ply|spz|splat|ksplat)$/i.test(url.pathname)) return { kind: 'model', url: input, hint: '这是模型文件地址，可能会过期。请粘贴影石作品的网页分享链接，由服务端获取模型。此入口不接收本地模型文件。' };
    if (url.hostname === 'app.insta360.com') return { kind: 'source', url: input, hint: url.hash ? '链接含 # 附加片段，不能直接导入。请重新复制作品的网页分享链接，或删除 # 及其后内容。' : '这不是当前支持的时光舱作品地址。请打开作品，选择“网页链接分享”，复制 /3dspace/detail/ 开头的链接。' };
    return { kind: 'source', url: input, hint: '此来源暂不支持空间导入。可保存并打开原网页；导入请使用影石时光舱的作品网页链接。' };
  }
  const api = { parseShare, inspect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MemorySpatialLink = api;
})(globalThis);
