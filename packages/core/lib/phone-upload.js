// 手机扫码上传：把手机相册里的照片先暂存到临时桶，再由电脑下载回本地，
// 之后仍走标准三步上传写进正式桶（配额、扩展名校验只有一套逻辑）。
//
// 状态流转（都在后端 phone_upload_sessions 里）：
//   waiting → uploading → completed → importing → done
// 本地只记「这次会话下载了哪些文件、落在哪个目录」，文件本身在
//   <workspace>/phone-upload/<session_id>/ 下，确认归档后可以整目录删掉。
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, rm, stat, copyFile } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'
import { isHeicFile, convertHeicToJpeg, jpegNameFor } from './heic.js'
import { readMeta } from './exif.js'
import { optimizeImageInPlace, toolsDir } from './lossless-tools.js'
import { formatBytes } from './photo-scan.js'

const STATE_FILE = 'phone-upload.json'

function todayStamp() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

async function fileSize(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : 0
  } catch {
    return 0
  }
}

export function createPhoneUpload({ workspaceDir, authed, openWindow, logger }) {
  const stateFile = join(workspaceDir, STATE_FILE)
  let review = null

  async function readState() {
    try {
      const data = JSON.parse(await readFile(stateFile, 'utf8'))
      return data && typeof data === 'object' ? data : null
    } catch {
      return null
    }
  }

  async function writeState(patch) {
    const prev = (await readState()) || {}
    const next = { ...prev, ...patch, updatedAt: new Date().toISOString() }
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(stateFile, JSON.stringify(next, null, 2), 'utf8')
    return next
  }

  async function clearState() {
    await rm(stateFile, { force: true }).catch(() => {})
  }

  async function callStatus(sessionId) {
    const result = await authed('/phone_upload/status', { session_id: sessionId }, { noRetryFromPage: true })
    return result
  }

  // ---------- 桌面确认窗（127.0.0.1，token 不出本机） ----------
  function renderReviewPage({ qrImage, uploadUrl }) {
    const qrBlock = qrImage
      ? `<img class="qr" src="${qrImage}" alt="上传二维码" />`
      : `<div class="qr qr-empty">二维码生成失败，请在手机浏览器打开下面的地址</div>`
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>手机上传照片 · 青史</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; font-family: 'PingFang SC','Microsoft YaHei',system-ui,sans-serif;
    background: radial-gradient(circle at 50% 0%, #fdf8ee 0%, #f6ecdc 48%, #efe3cf 100%); color: #2c211a; }
  .wrap { max-width: 820px; margin: 0 auto; padding: 34px 24px 48px; }
  .card { background: linear-gradient(180deg,#fffdf8,#fdf6ea); border: 1px solid rgba(138,109,59,.16);
    border-radius: 20px; box-shadow: 0 20px 54px rgba(111,86,71,.13); padding: 28px; }
  .head { display: flex; align-items: center; gap: 14px; }
  .seal { width: 46px; height: 46px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(150deg,#b66234,#8a4b2a); color: #fff7ea; font-weight: 700; letter-spacing: 2px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { font-size: 13px; color: #7d6a58; margin: 0; }
  .body { display: flex; gap: 26px; margin-top: 24px; align-items: flex-start; flex-wrap: wrap; }
  .qr { width: 240px; height: 240px; border-radius: 14px; background: #fff; padding: 10px; border: 1px solid rgba(138,109,59,.16); object-fit: contain; }
  .qr-empty { display: flex; align-items: center; justify-content: center; text-align: center; font-size: 13px; color: #b66234; padding: 24px; }
  .right { flex: 1; min-width: 260px; }
  .status { display: inline-flex; align-items: center; gap: 8px; padding: 7px 14px; border-radius: 999px;
    background: rgba(138,109,59,.1); font-size: 13px; font-weight: 700; color: #6f5647; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #8a4b2a; }
  .dot.live { animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.25} }
  .metrics { display: flex; gap: 26px; margin: 16px 0 4px; }
  .metric b { display: block; font-size: 22px; color: #6f5647; }
  .metric span { font-size: 12px; color: #9a8874; }
  .hint { font-size: 13px; color: #7d6a58; line-height: 1.7; margin-top: 12px; }
  .url { font-size: 12px; word-break: break-all; color: #8a7560; background: rgba(138,109,59,.06); padding: 10px 12px; border-radius: 10px; margin-top: 10px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(86px,1fr)); gap: 10px; margin-top: 20px; }
  .thumb { aspect-ratio: 1; border-radius: 10px; overflow: hidden; background: #efe3cf; border: 1px solid rgba(138,109,59,.1); cursor: zoom-in; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .lightbox { position: fixed; inset: 0; z-index: 60; display: none; align-items: center; justify-content: center;
    background: rgba(24,17,12,.9); padding: 24px; }
  .lightbox.show { display: flex; }
  .lightbox img { max-width: 94vw; max-height: 92vh; border-radius: 10px; box-shadow: 0 24px 70px rgba(0,0,0,.55); }
  .lightbox-tip { position: absolute; left: 0; right: 0; bottom: 18px; text-align: center; font-size: 13px; color: rgba(255,248,237,.72); }
  .closed { min-height: 100vh; display: flex; align-items: center; justify-content: center; font-size: 18px; color: #6f5647; }
  .empty { margin-top: 18px; padding: 26px; text-align: center; border: 1px dashed rgba(138,109,59,.24);
    border-radius: 14px; color: #9a8874; font-size: 13px; }
  .actions { display: flex; gap: 12px; margin-top: 24px; }
  button { flex: 1; height: 46px; border: 0; border-radius: 999px; font-size: 15px; font-weight: 700; cursor: pointer; }
  .primary { background: linear-gradient(160deg,#9a5a33,#8a4b2a 60%,#6f3a1f); color: #fff8ed; }
  .ghost { background: rgba(138,109,59,.09); color: #6f5647; border: 1px solid rgba(138,109,59,.16); }
  button:disabled { opacity: .45; cursor: default; }
  .foot { margin-top: 16px; font-size: 12px; color: #a2907c; text-align: center; }
  /* ===== 分类预览 ===== */
  .preview-head { margin-top: 28px; padding-top: 20px; border-top: 1px solid rgba(138,109,59,.14); }
  .preview-title { font-size: 15px; font-weight: 700; color: #6f5647; margin: 0 0 14px; display: flex; align-items: center; gap: 10px; }
  .preview-title .badge { background: linear-gradient(160deg,#9a5a33,#8a4b2a); color: #fff8ed; font-size: 12px; padding: 2px 10px; border-radius: 999px; }
  .preview-loading { font-size: 13px; color: #9a8874; text-align: center; padding: 24px; }
  .preview-event { margin-bottom: 18px; padding: 16px; background: linear-gradient(180deg,#fff8ec,#fdf0da); border: 1px solid rgba(138,109,59,.14); border-radius: 14px; }
  .preview-event.discard { background: linear-gradient(180deg,#fdf3f3,#fae0e0); border-color: rgba(193,70,70,.22); }
  .preview-event-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .preview-event-num { width: 24px; height: 24px; border-radius: 50%; background: linear-gradient(160deg,#9a5a33,#8a4b2a); color: #fff8ed; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
  .preview-event-title { font-size: 15px; font-weight: 700; color: #3b2a1e; }
  .preview-event-tag { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: rgba(138,109,59,.12); color: #6f5647; }
  .preview-event-date { font-size: 12px; color: #8a7560; }
  .preview-event-basis { margin-top: 6px; font-size: 12px; color: #9a8874; line-height: 1.6; }
  .preview-event-files { margin-top: 10px; display: grid; grid-template-columns: repeat(auto-fill,minmax(110px,1fr)); gap: 8px; }
  .preview-file { aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: #efe3cf; position: relative; cursor: zoom-in; }
  .preview-file img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .preview-file .fnum { position: absolute; top: 3px; left: 3px; background: rgba(0,0,0,.55); color: #fff; font-size: 10px; padding: 1px 6px; border-radius: 999px; }
  .preview-file .fname { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,.6); color: #fff; font-size: 10px; padding: 2px 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .preview-event-ai { margin-top: 8px; padding: 8px 10px; background: rgba(138,109,59,.05); border-radius: 8px; font-size: 12px; color: #7d6a58; line-height: 1.6; }
</style></head>
<body><div class="wrap"><div class="card">
  <div class="head"><div class="seal">青史</div><div><h1>手机正在上传照片</h1>
    <p class="sub">用手机扫码选择照片，这里会实时显示收到的内容</p></div></div>
  <div class="body">
    <div>${qrBlock}${qrImage ? '' : `<div class="url">${uploadUrl}</div>`}</div>
    <div class="right">
      <div class="status"><span class="dot live" id="dot"></span><span id="statusText">等待扫码</span></div>
      <div class="metrics">
        <div class="metric"><b id="count">0</b><span>已收到</span></div>
        <div class="metric"><b id="bytes">0B</b><span>总大小</span></div>
      </div>
      <div class="hint" id="hint">手机选完照片后点「完成」，或者你在这里点「我已传完」。</div>
    </div>
  </div>
  <div id="list" class="empty">还没有收到照片</div>
  <div id="previewSection" class="preview-head" style="display:none;"></div>
  <div class="actions">
    <button class="ghost" id="cancelBtn">取消本次上传</button>
    <button class="primary" id="finishBtn" disabled>我已传完</button>
  </div>
  <div class="foot">关闭本窗口不会中断上传；回到青史的对话里继续操作即可</div>
</div></div>
<div class="lightbox" id="lightbox"><img id="lightboxImg" alt="" /><div class="lightbox-tip">点击任意处关闭</div></div>
<script>
const STATUS_TEXT = { waiting:'等待扫码', uploading:'手机上传中', completed:'已传完', importing:'电脑整理中', done:'已归档', expired:'已过期', canceled:'已取消' };
let lastKeys = '';
const thumbUrls = new Map();
function render(data) {
  if (!data) return;
  const files = data.files || [];
  document.getElementById('statusText').textContent = STATUS_TEXT[data.status] || data.status || '等待中';
  document.getElementById('count').textContent = files.length;
  document.getElementById('bytes').textContent = fmt(files.reduce((s,f)=>s+(f.file_size||0),0));
  document.getElementById('finishBtn').disabled = !files.length || data.status !== 'uploading' && data.status !== 'waiting';
  document.getElementById('finishBtn').textContent = (data.status === 'completed' || data.status === 'importing') ? '已传完，可关闭窗口' : '我已传完';
  // 只有文件集合变化时才重建列表：每次轮询后端都会换发签名 URL，
  // 若无条件重写 innerHTML，图片会每 2 秒重新加载一次。
  const keys = files.map(f => f.object_key || f.file_name || '').join('|');
  if (keys !== lastKeys) {
    lastKeys = keys;
    const list = document.getElementById('list');
    if (files.length) {
      list.className = 'grid';
      list.innerHTML = files.map(f => {
        const key = f.object_key || f.file_name || '';
        if (!thumbUrls.has(key) && f.url) thumbUrls.set(key, f.url);
        const src = thumbUrls.get(key) || f.url || '';
        return '<div class="thumb" title="'+(f.file_name||'')+'">'+(src?'<img src="'+src+'" loading="lazy" />':'')+'</div>';
      }).join('');
    } else {
      list.className = 'empty';
      list.textContent = '还没有收到照片';
    }
  }
  // 只在真正 done 时才倒计时关窗口（已经写完 + 临时区清了）；
  // completed / importing 阶段保持窗口打开，因为 AI 可能还在分类、用户还在 H5 预览页调；
  // 窗口关了也不影响上传（后端 continue），但用户看不到实时状态、体验不好。
  if (data.status === 'done') {
    archived = true;
    startAutoClose();
  } else {
    stopAutoClose();
    archived = false;
  }
}
let autoCloseAt = 0;
let autoCloseTimer = null;
let archived = false;
function stopAutoClose(){
  if (autoCloseTimer) { clearInterval(autoCloseTimer); autoCloseTimer = null; }
  autoCloseAt = 0;
}
function startAutoClose(){
  if (!autoCloseAt) {
    autoCloseAt = Date.now() + 180000;
    autoCloseTimer = setInterval(tickAutoClose, 1000);
  }
  tickAutoClose();
}
function tickAutoClose(){
  const left = Math.max(0, autoCloseAt - Date.now());
  if (left <= 0) {
    stopAutoClose();
    try { window.close(); } catch (e) {}
    setTimeout(() => { document.body.innerHTML = '<div class="closed">已上传完成，可以关闭本窗口了。</div>'; }, 400);
    return;
  }
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  const hint = document.getElementById('hint');
  if (hint) hint.textContent = (archived ? '照片已归档' : '手机已上传完成') + '，本窗口可以关闭；将在 ' + m + ':' + String(s).padStart(2,'0') + ' 后自动关闭。';
}
function fmt(n){ if(n>=1048576) return (n/1048576).toFixed(1)+'MB'; if(n>=1024) return Math.ceil(n/1024)+'KB'; return n+'B'; }
async function poll(){
  try { const r = await fetch('/api/status'); const j = await r.json(); if (j.ok) render(j.data); } catch(e){}
}
async function act(path){
  const r = await fetch(path, { method:'POST' }); const j = await r.json().catch(()=>({}));
  if (!j.ok) alert(j.message || '操作失败');
  poll();
}
document.getElementById('finishBtn').addEventListener('click', ()=>act('/api/finish'));
document.getElementById('cancelBtn').addEventListener('click', ()=>{ if (confirm('确定取消这次上传？临时区会被清空。')) act('/api/cancel'); });
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightboxImg');
function closeLightbox(){ lightbox.classList.remove('show'); lightboxImg.removeAttribute('src'); }
document.getElementById('list').addEventListener('click', (event) => {
  const thumb = event.target.closest ? event.target.closest('.thumb') : null;
  const img = thumb && thumb.querySelector('img');
  if (!img || !img.src) return;
  lightboxImg.src = img.src;
  lightbox.classList.add('show');
});
lightbox.addEventListener('click', closeLightbox);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeLightbox(); });
poll(); setInterval(poll, 2000);
// preview 轮询：只有 status 到 completed 才开始（上传完了 AI 才会分类）
let previewStarted = false;
let previewPollTimer = null;
let lastPreviewKey = '';
async function pollPreview() {
  try {
    const r = await fetch('/api/preview');
    const j = await r.json();
    if (!j.ok) return;
    renderPreview(j.data || {});
  } catch (e) {}
}
function renderPreview(data) {
  const section = document.getElementById('previewSection');
  if (!section) return;
  const events = data.planned_events || [];
  const hasPreview = data.has_preview === true;
  // 状态判断
  const statusEl = document.getElementById('statusText');
  const curStatus = statusEl ? statusEl.textContent : '';
  // 还没传完 → 完全不显示 preview 区
  if (!previewStarted) {
    if (curStatus === '已传完' || curStatus === '电脑整理中' || curStatus === '已归档') {
      previewStarted = true;
      section.style.display = 'block';
    } else {
      section.style.display = 'none';
      return;
    }
  }
  section.style.display = 'block';
  if (!hasPreview || !events.length) {
    section.innerHTML = '<div class="preview-title"><span class="badge">AI</span> 正在分类...</div><div class="preview-loading">AI 正在根据照片的拍摄时间和地点归类，稍后这里会显示完整分类结果</div>';
    return;
  }
  // 去重：只有 events 集合真的变了才重建 DOM（避免签名 URL 刷新导致图片闪）
  const key = events.map(e => (e.title || '') + '|' + (e.file_keys || []).join(',')).join('||');
  if (key === lastPreviewKey && section.dataset.rendered === '1') return;
  lastPreviewKey = key;
  section.dataset.rendered = '1';

  const htmlParts = [];
  htmlParts.push('<div class="preview-title"><span class="badge">' + events.length + '</span> 归类好 ' + events.filter(e => !e.discard).length + ' 段经历' + (events.some(e => e.discard) ? ' · 🗑️ ' + events.filter(e => e.discard).length + ' 张归入废弃' : '') + '</div>');
  const normalEvents = events.filter(e => !e.discard);
  const discardEvents = events.filter(e => e.discard);
  let idx = 0;
  for (const ev of normalEvents) {
    idx++;
    const fileKeys = ev.file_keys || [];
    const photos = ev.photos || [];
    const photosByKey = {};
    for (const p of photos) if (p.file_key) photosByKey[p.file_key] = p;
    htmlParts.push('<div class="preview-event">');
    htmlParts.push('<div class="preview-event-head">');
    htmlParts.push('<span class="preview-event-num">' + idx + '</span>');
    htmlParts.push('<span class="preview-event-title">' + (ev.title || '未命名经历') + '</span>');
    if (ev.eventTag) htmlParts.push('<span class="preview-event-tag">#' + ev.eventTag + '</span>');
    if (ev.startDate) htmlParts.push('<span class="preview-event-date">📅 ' + ev.startDate + '</span>');
    if (ev.merge_to_event_id) htmlParts.push('<span class="preview-event-tag">🔗 合并到已有事件</span>');
    htmlParts.push('</div>');
    if (ev.classification_basis) htmlParts.push('<div class="preview-event-basis">📎 归类依据：' + ev.classification_basis + '</div>');
    if (ev.content) htmlParts.push('<div class="preview-event-ai">✍️ ' + ev.content + '</div>');
    if (fileKeys.length) {
      htmlParts.push('<div class="preview-event-files">');
      for (let i = 0; i < fileKeys.length; i++) {
        const fk = fileKeys[i];
        const photo = photosByKey[fk] || {};
        const imgSrc = photo.signed_url || '';
        const fname = photo.file_name || ('图片 ' + (i + 1));
        htmlParts.push('<div class="preview-file" title="' + fname + '">');
        if (imgSrc) htmlParts.push('<img src="' + imgSrc + '" loading="lazy" />');
        htmlParts.push('<span class="fnum">#' + (i + 1) + '</span>');
        htmlParts.push('<span class="fname">' + fname + (photo.ai_analysis ? ' · ' + photo.ai_analysis : '') + '</span>');
        htmlParts.push('</div>');
      }
      htmlParts.push('</div>');
    }
    htmlParts.push('</div>');
  }
  if (discardEvents.length) {
    const discardFiles = discardEvents.flatMap(e => e.file_keys || []);
    const discardPhotos = discardEvents.flatMap(e => e.photos || []);
    htmlParts.push('<div class="preview-event discard">');
    htmlParts.push('<div class="preview-event-head"><span class="preview-event-num" style="background:linear-gradient(160deg,#c14646,#8a2a2a)">🗑️</span>');
    htmlParts.push('<span class="preview-event-title">归入废弃的 ' + discardFiles.length + ' 张照片</span>');
    htmlParts.push('</div>');
    htmlParts.push('<div class="preview-event-basis">📎 AI 判断为重复、模糊或无关，默认不录入青史</div>');
    if (discardFiles.length) {
      htmlParts.push('<div class="preview-event-files">');
      const dpByKey = {};
      for (const p of discardPhotos) if (p.file_key) dpByKey[p.file_key] = p;
      for (let i = 0; i < discardFiles.length; i++) {
        const photo = dpByKey[discardFiles[i]] || {};
        const fname = photo.file_name || ('图片 ' + (i + 1));
        htmlParts.push('<div class="preview-file" title="' + fname + '">');
        if (photo.signed_url) htmlParts.push('<img src="' + photo.signed_url + '" loading="lazy" />');
        htmlParts.push('<span class="fnum">#' + (i + 1) + '</span>');
        htmlParts.push('<span class="fname">' + fname + '</span>');
        htmlParts.push('</div>');
      }
      htmlParts.push('</div>');
    }
    htmlParts.push('</div>');
  }
  section.innerHTML = htmlParts.join('');
}
// 每 3 秒轮询 preview（只在 previewStarted=true 时才真发请求）
setInterval(() => { if (previewStarted) pollPreview(); }, 3000);
</script></body></html>`
  }

  async function startReviewWindow(sessionId, qrImage, uploadUrl) {
    if (review) {
      review.close()
      review = null
    }
    let timer = null
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const send = (code, body, type = 'application/json; charset=utf-8') => {
        res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
        res.end(typeof body === 'string' ? body : JSON.stringify(body))
      }
      try {
        if (req.method === 'GET' && url.pathname === '/') {
          return send(200, renderReviewPage({ qrImage, uploadUrl }), 'text/html; charset=utf-8')
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const result = await callStatus(sessionId)
          if (result.code !== 200) return send(200, { ok: false, message: result.message || '读取失败' })
          const data = result.data || {}
          if (['done', 'canceled', 'expired'].includes(String(data.status || ''))) {
            if (!timer) timer = setTimeout(() => server.close(), 60000).unref?.()
          }
          return send(200, { ok: true, data })
        }
        if (req.method === 'GET' && url.pathname === '/api/preview') {
          // 代理到后端 preview_read，让电脑窗口也能看到 AI 分类结果
          const result = await authed('/phone_upload/preview_read', { session_id: sessionId })
          if (result.code !== 200) return send(200, { ok: false, message: result.message || '读取失败' })
          const data = result.data || {}
          return send(200, { ok: true, data })
        }
        if (req.method === 'POST' && url.pathname === '/api/finish') {
          const result = await authed('/phone_upload/finish', { session_id: sessionId })
          return send(200, { ok: result.code === 200, message: result.message })
        }
        if (req.method === 'POST' && url.pathname === '/api/cancel') {
          const result = await authed('/phone_upload/cancel', { session_id: sessionId })
          return send(200, { ok: result.code === 200, message: result.message })
        }
        return send(404, { ok: false, message: 'Not Found' })
      } catch (error) {
        logger?.('手机上传确认窗出错：' + (error?.message || String(error)))
        return send(500, { ok: false, message: error?.message || '服务出错' })
      }
    })

    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const port = server.address().port
    const localUrl = `http://127.0.0.1:${port}/`
    const close = () => {
      if (timer) clearTimeout(timer)
      try {
        server.close()
      } catch {
        /* ignore */
      }
    }
    review = { close, url: localUrl }
    const opened = typeof openWindow === 'function'
      ? openWindow(localUrl, { width: 860, height: 720, title: '手机上传照片' })
      : null
    return { url: localUrl, opened }
  }

  // ---------- 工具动作 ----------
  async function start({ openReview = true } = {}) {
    const result = await authed('/phone_upload/start', {})
    if (result.code !== 200 || !result.data) {
      return { ok: false, message: `发起手机上传失败：${result.code} ${result.message || ''}`.trim() }
    }
    const data = result.data
    const sessionId = String(data.session_id || '')
    if (!sessionId) return { ok: false, message: '后端没有返回 session_id' }

    await writeState({
      sessionId,
      uid: String(data.uid || ''),
      prefix: String(data.prefix || ''),
      status: String(data.status || 'waiting'),
      expiresIn: Number(data.expires_in || 0),
      files: [],
    })

    let window = { opened: false }
    if (openReview) {
      window = await startReviewWindow(sessionId, String(data.qr_image || ''), String(data.upload_url || ''))
    }
    return {
      ok: true,
      reused: Boolean(data.reused),
      sessionId,
      uploadUrl: String(data.upload_url || ''),
      hasQr: Boolean(data.qr_image),
      window,
    }
  }

  async function status({ sessionId = '', waitSeconds = 0 } = {}) {
    const state = await readState()
    const sid = String(sessionId || state?.sessionId || '')
    if (!sid) return { ok: false, message: '当前没有进行中的手机上传会话，先用 qingshi_phone_upload_start 发起。' }

    const deadline = Date.now() + Math.max(0, Number(waitSeconds) || 0) * 1000
    let last = null
    while (true) {
      const result = await callStatus(sid)
      if (result.code !== 200) {
        return { ok: false, message: `读取上传状态失败：${result.code} ${result.message || ''}`.trim() }
      }
      last = result.data
      const statusText = String(last?.status || '')
      if (!waitSeconds || ['completed', 'importing', 'done', 'canceled', 'expired'].includes(statusText)) break
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    if (!last) return { ok: false, message: '读取上传状态为空' }

    await writeState({ sessionId: sid, status: String(last.status || ''), expiresIn: Number(last.expires_in || 0) })
    return {
      ok: true,
      sessionId: sid,
      status: String(last.status || ''),
      files: Array.isArray(last.files) ? last.files : [],
      expiresIn: Number(last.expires_in || 0),
      maxFiles: Number(last.max_files || 0),
      totalBytes: Number(last.total_bytes || 0),
    }
  }

  async function downloadOne(url, targetPath) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length) throw new Error('下载到 0 字节')
    await writeFile(targetPath, buffer)
    return buffer.length
  }

  async function pick({ compression = 'original', allowInstall = false } = {}) {
    const current = await status({ waitSeconds: 0 })
    if (!current.ok) return { ok: false, message: current.message }
    const statusText = current.status
    if (statusText === 'waiting') {
      return { ok: false, message: '手机还未上传完毕：还没有扫码上传照片。请在手机上选好照片，并在手机上或电脑确认窗点击「上传完成」，然后再开始整理。' }
    }
    if (statusText === 'uploading') {
      return { ok: false, message: `手机还未上传完毕（已收到 ${current.files.length} 张）。请在手机上或电脑确认窗点击「上传完成」，然后再开始整理。` }
    }
    if (!['completed', 'importing'].includes(statusText)) {
      return { ok: false, message: `这次上传已经结束（状态：${statusText}），不能再取照片。需要重新发起就再调 start。` }
    }
    if (!current.files.length) {
      return { ok: false, message: '临时区里没有照片。让用户在手机上重新扫码选择。' }
    }

    const targetDir = join(workspaceDir, 'phone-upload', current.sessionId)
    await mkdir(targetDir, { recursive: true })

    const previous = (await readState()) || {}
    const previousByKey = new Map((previous.files || []).map((item) => [item.objectKey, item]))
    const files = []
    const problems = []
    const notes = []
    let needConsent = false
    let downloaded = 0
    let compressedSaved = 0

    for (const [index, item] of current.files.entries()) {
      const objectKey = String(item.object_key || '')
      const originalName = String(item.file_name || basename(objectKey) || `photo_${index + 1}.jpg`)
      const extension = extname(originalName) || '.jpg'
      const safeName = `${String(index + 1).padStart(3, '0')}_${basename(originalName, extname(originalName)).replace(/[\\/:*?"<>|]/g, '_')}${extension}`

      const cached = previousByKey.get(objectKey)
      let localPath = cached?.localPath && (await fileSize(cached.localPath)) > 0 ? cached.localPath : ''
      let tookAt = cached?.takenAt || ''

      if (!localPath) {
        if (!item.url) {
          problems.push(`${originalName}：后端没有给出下载地址（签名可能过期），这次跳过`)
          continue
        }
        localPath = join(targetDir, safeName)
        try {
          await downloadOne(String(item.url), localPath)
          downloaded += 1
        } catch (error) {
          problems.push(`${originalName}：${error.message}`)
          continue
        }
      }

      // HEIC → JPG（暂存桶允许 HEIC，正式桶不支持）
      if (await isHeicFile(localPath)) {
        try {
          const converted = await convertHeicToJpeg(localPath)
          const jpgPath = join(targetDir, jpegNameFor(safeName))
          await copyFile(converted.path, jpgPath)
          await converted.cleanup?.()
          const rawBytes = await fileSize(localPath)
          await rm(localPath, { force: true }).catch(() => {})
          localPath = jpgPath
          notes.push(`${originalName}：HEIC 已转 JPG（${formatBytes(rawBytes)} 原文件已换掉）`)
        } catch (error) {
          problems.push(`${originalName}：HEIC 转 JPG 失败（${error.message}）`)
          continue
        }
      }

      const meta = await readMeta(localPath).catch(() => null)
      tookAt = tookAt || meta?.takenAt || item.taken_at || ''

      let compress = null
      if (String(compression).toLowerCase() === 'lossless') {
        compress = await optimizeImageInPlace(localPath, { workspaceDir, allowInstall, logger })
        if (compress.needConsent) needConsent = true
        if (compress.bytesAfter > 0 && compress.bytesAfter < compress.bytesBefore) {
          compressedSaved += compress.bytesBefore - compress.bytesAfter
        } else if (compress.note && !compress.needConsent && !compress.note.includes('该格式')) {
          notes.push(`${basename(localPath)}：${compress.note}`)
        }
      }

      files.push({
        objectKey,
        fileName: originalName,
        localPath,
        takenAt: tookAt,
        bytes: await fileSize(localPath),
        sourceBytes: Number(item.file_size || 0),
        gps: meta?.gps || item.gps || null,
        tool: compress?.tool || '',
        localDir: targetDir,
      })
    }

    await writeState({
      sessionId: current.sessionId,
      status: 'importing',
      files,
      downloadedAt: new Date().toISOString(),
    })

    return {
      ok: files.length > 0,
      sessionId: current.sessionId,
      localDir: targetDir,
      files,
      problems,
      notes,
      needConsent,
      downloaded,
      compressedSaved,
      toolsDir: toolsDir(workspaceDir),
    }
  }

  async function finish({ eventIds = [], cancel = false } = {}) {
    const state = await readState()
    const sessionId = String(state?.sessionId || '')
    if (!sessionId) return { ok: false, message: '没有可收尾的手机上传会话。' }
    if (cancel) {
      const result = await authed('/phone_upload/cancel', { session_id: sessionId })
      if (result.code !== 200) return { ok: false, message: `取消失败：${result.message || ''}` }
      await clearState()
      return { ok: true, canceled: true, message: '已取消并清理临时区。' }
    }
    const ids = Array.isArray(eventIds)
      ? eventIds.map((id) => String(id || '').trim()).filter(Boolean)
      : []
    const result = await authed('/phone_upload/imported', { session_id: sessionId, event_ids: ids })
    if (result.code !== 200) return { ok: false, message: `归档收尾失败：${result.message || ''}` }
    // 只清后端临时目录：本地下载的照片是用户原图的副本，保留在 phone-upload/<session_id>/ 不动
    await clearState()
    return {
      ok: true,
      canceled: false,
      removed: Number(result.data?.removed || 0),
      eventCount: ids.length,
      message: '已登记导入并清理临时区。',
    }
  }

  return { start, status, pick, finish, readState, todayStamp }
}
