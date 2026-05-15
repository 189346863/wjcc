// _worker.js - KV 公共文件存储系统（加固版）
// 目标：继续使用 Workers KV 存储文件；文件下载/浏览公开；上传、删除、移动、生成外链、修改配置需要后端密码校验。

const DEFAULT_ADMIN_PASSWORD = "ww1234"; // 仅作为未配置 ADMIN_PASSWORD 时的兜底值。正式部署请设置 ADMIN_PASSWORD。
const KV_BINDING_NAME = "music_kv";
const KV_MAX_VALUE_BYTES = 25 * 1024 * 1024; // Workers KV 单 value 最大 25 MiB
const DEFAULT_MAX_FILE_SIZE_BYTES = 24 * 1024 * 1024; // 留一点余量，避免边界错误
const DEFAULT_BLOCKED_EXTENSIONS = [
  "html", "htm", "svg", "js", "mjs", "cjs", "wasm", "css",
  "php", "phtml", "asp", "aspx", "jsp",
  "sh", "bash", "zsh", "bat", "cmd", "ps1",
  "exe", "dll", "so", "dmg", "app", "apk", "jar",
  "scr", "msi", "com", "vbs", "wsf"
];
const SAFE_INLINE_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "ico"];

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="#3b82f6"/><text x="50" y="67" text-anchor="middle" fill="white" font-size="45" font-family="Arial">📁</text></svg>`;

function formatFileSizeStatic(bytes) {
  const n = Number(bytes || 0);
  if (n <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(k)), sizes.length - 1);
  return parseFloat((n / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function parseHumanSizeToBytes(text) {
  if (!text) return 0;
  const m = String(text).trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const map = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.round(num * (map[unit] || 1));
}

function jsonResponse(data, init = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(init.headers || {})
    }
  });
}

function htmlResponse(html, init = {}) {
  return new Response(html, {
    ...init,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...(init.headers || {})
    }
  });
}

function textResponse(text, init = {}) {
  return new Response(text, {
    ...init,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...(init.headers || {})
    }
  });
}

function getKV(env) {
  const kv = env && env[KV_BINDING_NAME];
  if (!kv) throw new Error("缺少 KV 绑定：" + KV_BINDING_NAME);
  return kv;
}

function getMaxFileSize(env) {
  const configured = Number(env && env.MAX_FILE_SIZE_BYTES);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(configured, KV_MAX_VALUE_BYTES);
  }
  return DEFAULT_MAX_FILE_SIZE_BYTES;
}

function getBlockedExtensions(env) {
  const extra = String((env && env.BLOCKED_EXTENSIONS) || "")
    .split(",")
    .map(s => s.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean);
  return new Set([...DEFAULT_BLOCKED_EXTENSIONS, ...extra]);
}

function getExtension(filename) {
  const base = String(filename || "").split(/[\\/]/).pop();
  const idx = base.lastIndexOf(".");
  if (idx < 0) return "";
  return base.slice(idx + 1).toLowerCase();
}

function sanitizeFileName(name) {
  const fallback = "file";
  let clean = String(name || fallback)
    .replace(/[\x00-\x1F\x7F/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || clean === "." || clean === "..") clean = fallback;
  if (clean.length > 120) {
    const ext = getExtension(clean);
    const stem = clean.slice(0, Math.max(1, 110 - ext.length));
    clean = ext ? stem + "." + ext : stem;
  }
  return clean;
}

function makeStorageFileName(name) {
  return sanitizeFileName(name)
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]/g, "_")
    .slice(0, 100) || "file";
}

function getMimeType(filename) {
  const ext = getExtension(filename);
  const map = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    ico: "image/x-icon",
    pdf: "application/pdf",
    txt: "text/plain; charset=utf-8",
    json: "application/json; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    webm: "video/webm",
    zip: "application/zip",
    rar: "application/vnd.rar",
    "7z": "application/x-7z-compressed"
  };
  return map[ext] || "application/octet-stream";
}

function isInlineImage(filename) {
  return SAFE_INLINE_IMAGE_EXTENSIONS.includes(getExtension(filename));
}

function isBlockedFilename(filename, env) {
  const ext = getExtension(filename);
  return ext && getBlockedExtensions(env).has(ext);
}

function normalizeUrlInput(value, { allowRelative = false } = {}) {
  const input = String(value || "").trim();
  if (!input) return "";
  if (allowRelative && input.startsWith("/") && !input.startsWith("//")) {
    return input;
  }
  try {
    const u = new URL(input);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch (_) {
    return null;
  }
  return null;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[ch]));
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function passwordDigest(password, salt) {
  return sha256Hex(String(salt) + ":" + String(password));
}

async function verifyAdminPassword(env, password) {
  if (!password) return false;
  const kv = getKV(env);
  const record = await kv.get("config:admin_password_hash", "json");
  if (record && record.salt && record.hash) {
    return (await passwordDigest(password, record.salt)) === record.hash;
  }

  // 兼容旧版本：旧代码把 admin_password 明文存入 KV。
  const legacyPassword = await kv.get("admin_password");
  if (legacyPassword) return String(password) === String(legacyPassword);

  const envPassword = (env && env.ADMIN_PASSWORD) || DEFAULT_ADMIN_PASSWORD;
  return String(password) === String(envPassword);
}

async function setAdminPassword(env, password) {
  const kv = getKV(env);
  const salt = randomHex(16);
  const hash = await passwordDigest(password, salt);
  await kv.put("config:admin_password_hash", JSON.stringify({ version: 1, salt, hash, updatedAt: Date.now() }));
  await kv.delete("admin_password"); // 清理旧版明文密码
}

function getClientIdentifier(request) {
  const cfIp = request.headers.get("CF-Connecting-IP");
  const forwarded = request.headers.get("X-Forwarded-For");
  const ip = cfIp || (forwarded ? forwarded.split(",")[0].trim() : "unknown");
  const ua = request.headers.get("User-Agent") || "unknown";
  return ip + "|" + ua.slice(0, 120);
}

async function rateLimit(env, request, bucket, limit, windowSeconds) {
  const kv = getKV(env);
  const idHash = (await sha256Hex(getClientIdentifier(request))).slice(0, 24);
  const key = "ratelimit:" + bucket + ":" + idHash;
  const now = Date.now();
  let state = await kv.get(key, "json");
  if (!state || !state.resetAt || state.resetAt <= now) {
    state = { count: 0, resetAt: now + windowSeconds * 1000 };
  }
  state.count += 1;
  try {
    await kv.put(key, JSON.stringify(state), { expirationTtl: windowSeconds + 120 });
  } catch (_) {
    // KV 对同一 key 有写频率限制；限流写入失败时不让主流程崩溃。
  }
  return {
    ok: state.count <= limit,
    retryAfter: Math.max(1, Math.ceil((state.resetAt - now) / 1000))
  };
}

async function listKVKeys(kv, options = {}) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ ...options, cursor });
    keys.push(...page.keys);
    cursor = page.cursor;
    if (page.list_complete) break;
  } while (cursor);
  return keys;
}

async function getFileMetadata(kv, fileId) {
  return kv.get("meta_" + fileId, "json");
}

async function listFiles(env) {
  const kv = getKV(env);
  const keys = await listKVKeys(kv, { prefix: "meta_" });
  const files = [];
  for (const key of keys) {
    if (key.name.startsWith("meta_share_")) continue;
    const fileId = key.name.replace(/^meta_/, "");
    const metadata = await kv.get(key.name, "json");
    if (!metadata) continue;
    const downloadCount = await kv.get("downloads_" + fileId) || "0";
    const sizeBytes = Number(metadata.sizeBytes || parseHumanSizeToBytes(metadata.size));
    files.push({
      id: fileId,
      name: metadata.name || fileId.replace(/^\d+_[a-f0-9-]+_/, ""),
      size: metadata.sizeText || metadata.size || formatFileSizeStatic(sizeBytes),
      sizeBytes,
      time: metadata.time || (metadata.uploadTime ? new Date(metadata.uploadTime).toLocaleString("zh-CN") : ""),
      uploadTime: Number(metadata.uploadTime || 0),
      folder: metadata.folder || "",
      downloads: parseInt(downloadCount, 10) || 0
    });
  }
  files.sort((a, b) => (b.uploadTime || 0) - (a.uploadTime || 0));
  return files;
}

async function deleteSharesForFile(kv, fileId) {
  const shareKeys = await listKVKeys(kv, { prefix: "share_" });
  let deleted = 0;
  for (const key of shareKeys) {
    const data = await kv.get(key.name, "json");
    if (data && data.fileId === fileId) {
      await kv.delete(key.name);
      deleted += 1;
    }
  }
  return deleted;
}

function getPasswordFromHeader(request) {
  return request.headers.get("X-Admin-Password") || "";
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (_) {
    return null;
  }
}

const ADMIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>修改密码</title><style>
*{margin:0;padding:0;box-sizing:border-box;}body{background:#0a0c15;font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:16px;color:#eef2ff}.card{background:#11131f;border-radius:28px;padding:28px;max-width:420px;width:100%;border:1px solid #334155}h2{margin-bottom:20px;text-align:center}input{width:100%;padding:12px 16px;margin:10px 0;border-radius:60px;background:#1e293b;border:1px solid #334155;color:white}button{background:#3b82f6;border:none;padding:12px;border-radius:60px;color:white;cursor:pointer;width:100%;margin-top:8px}.back{background:#334155;margin-top:15px;text-align:center;display:block;text-decoration:none;padding:12px;border-radius:60px;color:white}.hint{font-size:.75rem;color:#94a3b8;line-height:1.6;margin:8px 0 14px}.toast{position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#1e293b;color:#bef264;padding:10px 24px;border-radius:60px;display:none}
</style></head><body><div class="card"><h2>🔐 修改管理密码</h2><p class="hint">修改后会写入 KV 的哈希记录。当前浏览器标签页缓存的旧密码会自动失效。</p><input type="password" id="oldPwd" placeholder="当前密码"><input type="password" id="newPwd" placeholder="新密码，建议至少 8 位"><input type="password" id="confirmPwd" placeholder="确认新密码"><button id="saveBtn">保存</button><a href="/" class="back">← 返回首页</a></div><div id="toast" class="toast"></div><script>
function showToast(msg){var t=document.getElementById('toast');t.innerText=msg;t.style.display='block';setTimeout(function(){t.style.display='none';},2200);}async function save(){var old=document.getElementById('oldPwd').value;var newp=document.getElementById('newPwd').value;var confirm=document.getElementById('confirmPwd').value;if(!old||!newp||!confirm){showToast('请填写完整');return;}if(newp.length<8){showToast('新密码建议至少 8 位');return;}if(newp!==confirm){showToast('两次新密码不一致');return;}var res=await fetch('/api/admin/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({old:old,newPassword:newp})});var data=await res.json();if(data.success){sessionStorage.removeItem('adminPassword');showToast('修改成功');setTimeout(function(){location.href='/';},1200);}else{showToast(data.error||'修改失败');}}document.getElementById('saveBtn').onclick=save;
</script></body></html>`;

const PICTURE_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>更换 Logo</title><style>
*{margin:0;padding:0;box-sizing:border-box;}body{background:#0a0c15;font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:16px;color:#eef2ff}.card{background:#11131f;border-radius:28px;padding:28px;max-width:430px;width:100%;border:1px solid #334155}h2{margin-bottom:20px;text-align:center}input{width:100%;padding:12px 16px;margin:10px 0;border-radius:60px;background:#1e293b;border:1px solid #334155;color:white}button{background:#3b82f6;border:none;padding:12px;border-radius:60px;color:white;cursor:pointer;width:100%;margin-top:10px}.secondary{background:#475569}.back{background:#334155;margin-top:15px;text-align:center;display:block;text-decoration:none;padding:12px;border-radius:60px;color:white}.preview{text-align:center;margin:20px 0;padding:16px;background:#0a0c15;border-radius:20px}.preview img{max-width:80px;max-height:80px;border-radius:20px;object-fit:cover}.hint{font-size:.75rem;color:#94a3b8;line-height:1.6}.toast{position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#1e293b;color:#bef264;padding:10px 24px;border-radius:60px;display:none}
</style></head><body><div class="card"><h2>🖼️ 更换 Logo</h2><p class="hint">Logo 图片地址只接受 http/https 外链；跳转链接接受 http/https 或以 / 开头的站内路径。</p><input type="text" id="logoUrl" placeholder="Logo 图片地址，例如 https://..."><input type="text" id="logoLink" placeholder="点击 Logo 跳转链接，例如 https://... 或 /admin"><input type="password" id="pwd" placeholder="管理密码"><div class="preview"><span style="color:#94a3b8;">预览：</span><br><img id="preview" src="https://picsum.photos/id/20/100/100"></div><button id="saveBtn">保存</button><button id="resetBtn" class="secondary">恢复默认</button><a href="/" class="back">← 返回首页</a></div><div id="toast" class="toast"></div><script>
function showToast(msg){var t=document.getElementById('toast');t.innerText=msg;t.style.display='block';setTimeout(function(){t.style.display='none';},2200);}function updatePreview(){var url=document.getElementById('logoUrl').value.trim();document.getElementById('preview').src=url||'https://picsum.photos/id/20/100/100';}async function load(){var res=await fetch('/api/logo/get');var data=await res.json();if(data.success){document.getElementById('logoUrl').value=data.config.imgUrl||'';document.getElementById('logoLink').value=data.config.linkUrl||'';updatePreview();}}async function save(){var pwd=document.getElementById('pwd').value;var img=document.getElementById('logoUrl').value;var link=document.getElementById('logoLink').value;if(!pwd){showToast('请输入管理密码');return;}var res=await fetch('/api/logo/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd,imgUrl:img,linkUrl:link})});var data=await res.json();if(data.success){sessionStorage.setItem('adminPassword',pwd);showToast('保存成功');}else{showToast(data.error||'保存失败');}}async function reset(){var pwd=document.getElementById('pwd').value;if(!pwd){showToast('请输入管理密码');return;}var res=await fetch('/api/logo/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})});var data=await res.json();if(data.success){document.getElementById('logoUrl').value='';document.getElementById('logoLink').value='';updatePreview();showToast('已恢复默认');}else{showToast(data.error||'恢复失败');}}document.getElementById('logoUrl').oninput=updatePreview;document.getElementById('saveBtn').onclick=save;document.getElementById('resetBtn').onclick=reset;load();
</script></body></html>`;

const HTML_CONTENT = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=yes">
<title>云盘 · KV 公共存储</title>
<link rel="icon" type="image/svg+xml" href="/favicon.ico">
<style>
*{margin:0;padding:0;box-sizing:border-box}body{background:linear-gradient(135deg,#0a0c15 0%,#1a1d2e 100%);font-family:system-ui,-apple-system,sans-serif;color:#eef2ff;min-height:100vh;padding:20px}.header{text-align:center;margin-bottom:20px}.header h1{font-size:1.8rem;background:linear-gradient(135deg,#c084fc,#60a5fa);-webkit-background-clip:text;background-clip:text;color:transparent}.header p{font-size:.76rem;color:#94a3b8;margin-top:6px}.logo-area{position:fixed;top:15px;left:15px;cursor:pointer;z-index:100}.logo-img{width:60px;height:60px;border-radius:16px;object-fit:cover;background:#11131f}.toolbar{background:rgba(18,20,32,.72);backdrop-filter:blur(10px);border-radius:20px;padding:16px 20px;margin-bottom:20px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;border:1px solid rgba(148,163,184,.16)}.search-box{flex:2;min-width:190px;display:flex;gap:8px}.search-box input{flex:1;padding:10px 16px;border-radius:40px;background:#1e293b;border:1px solid #334155;color:white}.search-box button,.folder-select,.batch-btn,.clear-btn{padding:10px 18px;border-radius:40px;border:none;cursor:pointer}.folder-select{background:#1e293b;color:white;border:1px solid #334155}.batch-btn{background:#8b5cf6;color:white}.clear-btn{background:#475569;color:white}.upload-btn{background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:white;padding:10px 24px;border-radius:40px;border:none;cursor:pointer}.stats-bar{display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap}.stat-card{background:#11131f;border-radius:16px;padding:12px 20px;flex:1;text-align:center;border:1px solid #1f2937;min-width:120px}.stat-number{font-size:1.45rem;font-weight:700;color:#60a5fa}.stat-label{font-size:.7rem;color:#94a3b8}.files-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}.file-item{background:#11131f;border-radius:16px;padding:16px;border:1px solid #1f2937;transition:.2s;position:relative}.file-item:hover{background:#1a1d2e;transform:translateY(-2px)}.file-checkbox{position:absolute;top:12px;right:12px;width:20px;height:20px;cursor:pointer}.file-preview{text-align:center;margin-bottom:12px;cursor:pointer}.file-preview-img{max-width:100%;max-height:150px;border-radius:12px;object-fit:contain;background:#0a0c15}.file-preview-placeholder{height:100px;background:#0a0c15;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:2.5rem}.file-name{font-size:.85rem;font-weight:500;text-align:center;word-break:break-all;margin-bottom:4px;padding:0 18px}.file-meta{font-size:.62rem;color:#94a3b8;text-align:center;margin-bottom:12px}.file-actions{display:flex;gap:6px;justify-content:center;flex-wrap:wrap}.btn-sm{padding:6px 12px;border-radius:30px;font-size:.7rem;border:none;cursor:pointer}.btn-download{background:#3b82f6;color:white}.btn-share{background:#8b5cf6;color:white}.btn-delete{background:#ef4444;color:white}.btn-folder{background:#10b981;color:white}.modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.85);align-items:center;justify-content:center;z-index:1000;padding:16px}.modal-content{background:#0f111f;border-radius:28px;padding:28px;width:90%;max-width:500px;border:1px solid #334155}.modal-content h3{margin-bottom:12px}.modal-content select,.modal-content input,.modal-content textarea{width:100%;padding:12px;margin:10px 0;border-radius:20px;background:#1e293b;border:1px solid #334155;color:white}.modal-content button{margin:6px 4px 0 0}.share-link-box{background:#1e293b;padding:12px;border-radius:16px;margin:15px 0;word-break:break-all;font-size:.8rem}.link-type-buttons{display:flex;gap:10px;justify-content:center;margin:15px 0;flex-wrap:wrap}.link-type-btn{background:#1e293b;border:1px solid #3b82f6;padding:8px 16px;border-radius:40px;color:white;cursor:pointer;font-size:.8rem}.link-type-btn.active{background:#3b82f6}.toast{position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#1e293b;color:#bef264;padding:10px 24px;border-radius:60px;font-size:.85rem;display:none;z-index:1100;border:1px solid #334155}.empty{grid-column:1/-1;text-align:center;color:#94a3b8;padding:42px;background:#11131f;border-radius:18px;border:1px dashed #334155}.admin-links{text-align:center;margin:18px 0 4px;font-size:.75rem;color:#94a3b8}.admin-links a{color:#93c5fd;text-decoration:none;margin:0 8px}@media(max-width:768px){body{padding:12px}.header{display:none}.logo-area{position:static;text-align:center;margin-bottom:15px}.logo-img{width:80px;height:80px}.toolbar{flex-direction:column;align-items:stretch}.search-box{width:100%;min-width:0}.stats-bar{flex-direction:column}.files-grid{grid-template-columns:1fr}.toolbar button,.folder-select{width:100%}}
</style>
</head>
<body>
<div class="logo-area" id="logoArea"><img id="logoImg" class="logo-img" src="https://picsum.photos/id/20/60/60" alt="Logo"></div>
<div class="header"><h1>📁 KV 公共云盘</h1><p>文件公开下载；上传、删除、移动、生成外链需要管理密码。</p></div>
<div class="toolbar">
  <div class="search-box"><input type="text" id="searchInput" placeholder="🔍 搜索文件..."><button id="searchBtn">搜索</button></div>
  <select id="folderSelect" class="folder-select"><option value="">所有文件</option></select>
  <button id="batchDownloadBtn" class="batch-btn">📦 批量下载</button>
  <button id="clearSelectionBtn" class="clear-btn">清空选择</button>
  <button id="uploadBtn" class="upload-btn">📤 上传文件</button>
  <input type="file" id="fileInput" multiple style="display:none">
</div>
<div class="stats-bar" id="statsBar"></div>
<div id="fileList" class="files-grid"></div>
<div class="admin-links"><a href="/admin">修改密码</a> · <a href="/picture">更换 Logo</a></div>

<div id="passwordModal" class="modal"><div class="modal-content"><h3>🔐 需要管理密码</h3><p id="modalActionText" style="color:#94a3b8;font-size:.85rem;line-height:1.6">请输入操作密码</p><input type="password" id="modalPassword" placeholder="管理密码"><div><button id="modalConfirmBtn" class="btn-sm btn-download">确认</button><button id="modalCancelBtn" class="btn-sm btn-delete">取消</button></div></div></div>

<div id="shareModal" class="modal"><div class="modal-content"><h3>🔗 生成外链</h3><div class="link-type-buttons"><button class="link-type-btn active" data-type="direct">🔗 直接链接</button><button class="link-type-btn" data-type="markdown">📝 Markdown</button><button class="link-type-btn" data-type="html">🌐 HTML</button><button class="link-type-btn" data-type="bbcode">📋 BBCode</button></div><select id="expirySelect"><option value="1">1天后过期</option><option value="3">3天后过期</option><option value="7" selected>7天后过期</option><option value="0">永久有效</option></select><button id="generateShareBtn" class="btn-sm btn-share">生成外链</button><div id="shareLinkBox" class="share-link-box" style="display:none;"></div><button id="closeShareBtn" class="btn-sm btn-delete">关闭</button></div></div>

<div id="folderModal" class="modal"><div class="modal-content"><h3>📁 移动到文件夹</h3><select id="targetFolder"></select><button id="moveConfirmBtn" class="btn-sm btn-folder">确认移动</button><button id="moveCancelBtn" class="btn-sm btn-delete">取消</button></div></div>
<div id="toastMsg" class="toast"></div>

<script>
var allFiles=[];var selectedFiles=new Set();var currentShareFile=null;var currentLinkType='direct';var pendingMoveFile=null;var passwordResolver=null;
function $(id){return document.getElementById(id);}function showToast(msg){var t=$('toastMsg');t.innerText=msg;t.style.display='block';setTimeout(function(){t.style.display='none';},2400);}function getExt(n){var p=String(n||'').split('.');return p.length>1?p.pop().toLowerCase():'';}function isImageFile(n){return ['jpg','jpeg','png','gif','webp','bmp','ico'].indexOf(getExt(n))>=0;}function getFileIcon(n){var e=getExt(n);var m={jpg:'🖼️',jpeg:'🖼️',png:'🖼️',gif:'🖼️',webp:'🖼️',bmp:'🖼️',ico:'🖼️',mp4:'🎬',webm:'🎬',mp3:'🎵',wav:'🎵',flac:'🎵',pdf:'📄',zip:'🗜️',rar:'🗜️','7z':'🗜️',txt:'📝',json:'🧩',csv:'📊'};return m[e]||'📁';}function getAdminPassword(){return sessionStorage.getItem('adminPassword')||'';}function setAdminPassword(pwd){if(pwd)sessionStorage.setItem('adminPassword',pwd);}function clearAdminPassword(){sessionStorage.removeItem('adminPassword');}
async function verifyPassword(pwd){var res=await fetch('/api/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})});return res.json();}
function askPassword(text){return new Promise(function(resolve){passwordResolver=resolve;$('modalActionText').innerText=text||'请输入操作密码';$('modalPassword').value='';$('passwordModal').style.display='flex';setTimeout(function(){$('modalPassword').focus();},50);});}
async function ensureAdminPassword(text){var cached=getAdminPassword();if(cached){try{var ok=await verifyPassword(cached);if(ok.success)return cached;}catch(e){}clearAdminPassword();}var pwd=await askPassword(text);if(!pwd)return null;var data=await verifyPassword(pwd);if(data.success){setAdminPassword(pwd);return pwd;}showToast('密码错误');return null;}
async function apiJson(url,body){var res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});var data=await res.json().catch(function(){return {success:false,error:'接口返回异常'};});if(!res.ok&&data&&!data.error)data.error='请求失败：'+res.status;return data;}
async function fetchFiles(){var res=await fetch('/api/files');var data=await res.json();return data.files||[];}async function getStats(){var res=await fetch('/api/stats');return res.json();}
async function uploadFile(file,pwd){var fd=new FormData();fd.append('file',file);fd.append('password',pwd);var res=await fetch('/api/upload',{method:'POST',body:fd});var data=await res.json().catch(function(){return {success:false,error:'上传接口异常'};});if(!res.ok&&data&&!data.error)data.error='上传失败：'+res.status;return data;}
function makeButton(text,cls,onClick){var b=document.createElement('button');b.className='btn-sm '+cls;b.textContent=text;b.onclick=onClick;return b;}
function renderFileList(){var filtered=allFiles.slice();var search=$('searchInput').value.trim().toLowerCase();var folder=$('folderSelect').value;if(search)filtered=filtered.filter(function(f){return String(f.name||'').toLowerCase().indexOf(search)>=0;});if(folder)filtered=filtered.filter(function(f){return f.folder===folder;});var container=$('fileList');container.textContent='';if(!filtered.length){var empty=document.createElement('div');empty.className='empty';empty.textContent='📭 暂无文件';container.appendChild(empty);return;}filtered.forEach(function(f){var previewUrl='/api/download/'+encodeURIComponent(f.id);var div=document.createElement('div');div.className='file-item';var cb=document.createElement('input');cb.type='checkbox';cb.className='file-checkbox';cb.checked=selectedFiles.has(f.id);cb.onchange=function(){if(cb.checked)selectedFiles.add(f.id);else selectedFiles.delete(f.id);};div.appendChild(cb);var preview=document.createElement('div');preview.className='file-preview';preview.onclick=function(){window.open(previewUrl,'_blank');};if(isImageFile(f.name)){var img=document.createElement('img');img.className='file-preview-img';img.src=previewUrl;img.alt='预览';preview.appendChild(img);}else{var ph=document.createElement('div');ph.className='file-preview-placeholder';ph.textContent=getFileIcon(f.name);preview.appendChild(ph);}div.appendChild(preview);var name=document.createElement('div');name.className='file-name';name.textContent=f.name||f.id;div.appendChild(name);var meta=document.createElement('div');meta.className='file-meta';meta.textContent=(f.size||'0 B')+' · '+(f.time||'')+' · 下载'+(f.downloads||0)+'次';div.appendChild(meta);var actions=document.createElement('div');actions.className='file-actions';actions.appendChild(makeButton('⬇️ 下载','btn-download',function(){recordDownload(f.id);window.open(previewUrl,'_blank');}));actions.appendChild(makeButton('🔗 外链','btn-share',function(){currentShareFile=f.id;$('shareModal').style.display='flex';$('shareLinkBox').style.display='none';}));actions.appendChild(makeButton('📁 移动','btn-folder',function(){openFolderModal(f.id);}));actions.appendChild(makeButton('🗑️ 删除','btn-delete',function(){deleteFile(f.id);}));div.appendChild(actions);container.appendChild(div);});}
async function recordDownload(fileId){try{await fetch('/api/download/'+encodeURIComponent(fileId)+'/record',{method:'POST'});}catch(e){}}
async function refreshAll(){allFiles=await fetchFiles();loadFolders();renderFileList();await loadStats();}
function loadFolders(){var folders=[];allFiles.forEach(function(f){if(f.folder&&folders.indexOf(f.folder)<0)folders.push(f.folder);});var sel=$('folderSelect');var current=sel.value;sel.textContent='';var opt=document.createElement('option');opt.value='';opt.textContent='所有文件';sel.appendChild(opt);folders.forEach(function(folder){var o=document.createElement('option');o.value=folder;o.textContent='📁 '+folder;sel.appendChild(o);});sel.value=folders.indexOf(current)>=0?current:'';}
async function loadStats(){var stats=await getStats();var bar=$('statsBar');bar.textContent='';[['文件总数',stats.totalFiles],['总大小',stats.totalSize],['总下载次数',stats.totalDownloads]].forEach(function(item){var card=document.createElement('div');card.className='stat-card';var num=document.createElement('div');num.className='stat-number';num.textContent=item[1];var lab=document.createElement('div');lab.className='stat-label';lab.textContent=item[0];card.appendChild(num);card.appendChild(lab);bar.appendChild(card);});}
async function doUpload(files){var pwd=await ensureAdminPassword('上传文件需要管理密码');if(!pwd)return;for(var i=0;i<files.length;i++){var f=files[i];showToast('上传中：'+f.name);var resp=await uploadFile(f,pwd);if(resp.success){showToast('✅ 已上传：'+resp.name);}else{if(resp.error&&resp.error.indexOf('密码')>=0)clearAdminPassword();showToast('❌ '+(resp.error||'上传失败'));break;}}await refreshAll();}
async function deleteFile(fileId){var pwd=await ensureAdminPassword('删除文件需要管理密码');if(!pwd)return;if(!confirm('确定删除该文件？删除后会同步清理该文件对应的分享链接。'))return;var data=await apiJson('/api/delete',{id:fileId,password:pwd});if(data.success){selectedFiles.delete(fileId);showToast('删除成功');await refreshAll();}else{if(data.error&&data.error.indexOf('密码')>=0)clearAdminPassword();showToast(data.error||'删除失败');}}
function batchDownload(){if(selectedFiles.size===0){showToast('请先选择文件');return;}var ids=Array.from(selectedFiles);window.open('/api/batch-download?ids='+encodeURIComponent(JSON.stringify(ids)),'_blank');}
function openFolderModal(fileId){var folders=[];allFiles.forEach(function(f){if(f.folder&&folders.indexOf(f.folder)<0)folders.push(f.folder);});var sel=$('targetFolder');sel.textContent='';var root=document.createElement('option');root.value='';root.textContent='根目录';sel.appendChild(root);folders.forEach(function(folder){var o=document.createElement('option');o.value=folder;o.textContent='📁 '+folder;sel.appendChild(o);});var add=document.createElement('option');add.value='__new__';add.textContent='➕ 新建文件夹';sel.appendChild(add);sel.onchange=function(){if(sel.value==='__new__'){var newName=prompt('请输入文件夹名称');if(newName){newName=newName.trim().slice(0,50);var opt=document.createElement('option');opt.value=newName;opt.textContent='📁 '+newName;sel.insertBefore(opt,add);sel.value=newName;}else{sel.value='';}}};pendingMoveFile=fileId;$('folderModal').style.display='flex';}
async function confirmMove(){var pwd=await ensureAdminPassword('移动文件需要管理密码');if(!pwd)return;var folder=$('targetFolder').value;if(folder==='__new__'){showToast('请选择有效文件夹');return;}var data=await apiJson('/api/move',{id:pendingMoveFile,folder:folder,password:pwd});if(data.success){showToast('移动成功');$('folderModal').style.display='none';await refreshAll();}else{if(data.error&&data.error.indexOf('密码')>=0)clearAdminPassword();showToast(data.error||'移动失败');}}
function escapeMarkdownName(name){return String(name||'file').replace(/([\\\[\]\(\)])/g,function(m){return '\\'+m;});}
function escapeHtmlForSnippet(s){return String(s).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];});}
function formatLink(url,filename,linkType){var img=isImageFile(filename);if(linkType==='markdown')return img?'!['+escapeMarkdownName(filename)+']('+url+')':'['+escapeMarkdownName(filename)+']('+url+')';if(linkType==='html')return img?'<img src="'+url+'" alt="'+escapeHtmlForSnippet(filename)+'">':'<a href="'+url+'" target="_blank" rel="noopener">'+escapeHtmlForSnippet(filename)+'</a>';if(linkType==='bbcode')return img?'[img]'+url+'[/img]':'[url='+url+']'+filename+'[/url]';return url;}
function renderShareBox(text,expiryText){var box=$('shareLinkBox');box.textContent='';var title=document.createElement('div');title.style.marginBottom='8px';title.textContent='📎 外链地址（'+expiryText+'）：';var textarea=document.createElement('textarea');textarea.rows=3;textarea.readOnly=true;textarea.value=text;textarea.style.fontFamily='monospace';textarea.style.fontSize='.72rem';var copy=makeButton('📋 复制链接','btn-download',function(){textarea.select();document.execCommand('copy');showToast('已复制到剪贴板');});box.appendChild(title);box.appendChild(textarea);box.appendChild(copy);box.style.display='block';}
async function generateShare(){if(!currentShareFile){showToast('未选择文件');return;}var pwd=await ensureAdminPassword('生成外链需要管理密码');if(!pwd)return;var days=parseInt($('expirySelect').value,10);var data=await apiJson('/api/share',{id:currentShareFile,days:days,password:pwd});if(data.success){var file=allFiles.find(function(f){return f.id===currentShareFile;})||{name:'file'};var url=window.location.origin+'/s/'+data.shareId;var formatted=formatLink(url,file.name,currentLinkType);var expiryText=days===0?'永久有效':days+'天后过期';renderShareBox(formatted,expiryText);showToast('外链已生成');}else{if(data.error&&data.error.indexOf('密码')>=0)clearAdminPassword();showToast(data.error||'生成失败');}}
async function loadLogo(){try{var res=await fetch('/api/logo/get');var data=await res.json();if(data.success){var img=$('logoImg');if(data.config.imgUrl)img.src=data.config.imgUrl;var area=$('logoArea');area.style.cursor=data.config.linkUrl?'pointer':'default';area.onclick=function(){if(data.config.linkUrl)window.open(data.config.linkUrl,'_blank','noopener');};}}catch(e){}}
function bindEvents(){$('uploadBtn').onclick=function(){ $('fileInput').click();};$('fileInput').onchange=async function(e){await doUpload(Array.from(e.target.files||[]));e.target.value='';};$('searchBtn').onclick=renderFileList;$('searchInput').onkeydown=function(e){if(e.key==='Enter')renderFileList();};$('folderSelect').onchange=renderFileList;$('batchDownloadBtn').onclick=batchDownload;$('clearSelectionBtn').onclick=function(){selectedFiles.clear();renderFileList();};document.querySelectorAll('.link-type-btn').forEach(function(btn){btn.onclick=function(){document.querySelectorAll('.link-type-btn').forEach(function(b){b.classList.remove('active');});btn.classList.add('active');currentLinkType=btn.getAttribute('data-type');};});$('generateShareBtn').onclick=generateShare;$('closeShareBtn').onclick=function(){$('shareModal').style.display='none';};$('moveConfirmBtn').onclick=confirmMove;$('moveCancelBtn').onclick=function(){$('folderModal').style.display='none';};$('modalConfirmBtn').onclick=function(){var pwd=$('modalPassword').value;if(passwordResolver){passwordResolver(pwd);passwordResolver=null;}$('passwordModal').style.display='none';};$('modalCancelBtn').onclick=function(){if(passwordResolver){passwordResolver(null);passwordResolver=null;}$('passwordModal').style.display='none';};$('modalPassword').onkeydown=function(e){if(e.key==='Enter')$('modalConfirmBtn').click();};}
async function init(){await loadLogo();bindEvents();await refreshAll();}init();
</script>
</body>
</html>`;

export default {
  async fetch(request, env, ctx) {
    try {
      const kv = getKV(env);
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password"
          }
        });
      }

      if (path === "/favicon.ico") {
        return new Response(FAVICON_SVG, {
          headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=86400" }
        });
      }
      if (path === "/admin") return htmlResponse(ADMIN_PAGE);
      if (path === "/picture") return htmlResponse(PICTURE_PAGE);

      if (path === "/api/verify" && request.method === "POST") {
        const limited = await rateLimit(env, request, "verify", 20, 600);
        if (!limited.ok) return jsonResponse({ success: false, error: "尝试次数过多，请稍后再试" }, { status: 429, headers: { "Retry-After": String(limited.retryAfter) } });
        const body = await readJson(request);
        const ok = await verifyAdminPassword(env, body && body.password);
        return jsonResponse({ success: ok });
      }

      if (path === "/api/admin/password" && request.method === "POST") {
        const limited = await rateLimit(env, request, "change_password", 8, 900);
        if (!limited.ok) return jsonResponse({ success: false, error: "尝试次数过多，请稍后再试" }, { status: 429, headers: { "Retry-After": String(limited.retryAfter) } });
        const body = await readJson(request);
        if (!body) return jsonResponse({ success: false, error: "请求体不是有效 JSON" }, { status: 400 });
        const oldPwd = body.old || "";
        const newPwd = body.newPassword || body.new || "";
        if (!newPwd || String(newPwd).length < 8) return jsonResponse({ success: false, error: "新密码至少 8 位" }, { status: 400 });
        const ok = await verifyAdminPassword(env, oldPwd);
        if (!ok) return jsonResponse({ success: false, error: "当前密码错误" }, { status: 403 });
        await setAdminPassword(env, newPwd);
        return jsonResponse({ success: true });
      }

      if (path === "/api/logo/get") {
        const config = await kv.get("logo_config", "json") || { imgUrl: "", linkUrl: "" };
        return jsonResponse({ success: true, config });
      }

      if (path === "/api/logo/save" && request.method === "POST") {
        const body = await readJson(request);
        if (!body) return jsonResponse({ success: false, error: "请求体不是有效 JSON" }, { status: 400 });
        const ok = await verifyAdminPassword(env, body.password || getPasswordFromHeader(request));
        if (!ok) return jsonResponse({ success: false, error: "密码错误" }, { status: 403 });
        const imgUrl = normalizeUrlInput(body.imgUrl || "", { allowRelative: false });
        const linkUrl = normalizeUrlInput(body.linkUrl || "", { allowRelative: true });
        if (imgUrl === null) return jsonResponse({ success: false, error: "Logo 图片地址只允许 http/https URL" }, { status: 400 });
        if (linkUrl === null) return jsonResponse({ success: false, error: "Logo 跳转链接只允许 http/https URL 或 / 开头的站内路径" }, { status: 400 });
        await kv.put("logo_config", JSON.stringify({ imgUrl, linkUrl, updatedAt: Date.now() }));
        return jsonResponse({ success: true });
      }

      if (path === "/api/logo/reset" && request.method === "POST") {
        const body = await readJson(request);
        const ok = await verifyAdminPassword(env, (body && body.password) || getPasswordFromHeader(request));
        if (!ok) return jsonResponse({ success: false, error: "密码错误" }, { status: 403 });
        await kv.put("logo_config", JSON.stringify({ imgUrl: "", linkUrl: "", updatedAt: Date.now() }));
        return jsonResponse({ success: true });
      }

      if (path === "/api/files") {
        const files = await listFiles(env);
        return jsonResponse({ success: true, files });
      }

      if (path === "/api/stats") {
        const files = await listFiles(env);
        const totalFiles = files.length;
        const totalSizeBytes = files.reduce((sum, f) => sum + Number(f.sizeBytes || 0), 0);
        const totalDownloads = files.reduce((sum, f) => sum + Number(f.downloads || 0), 0);
        return jsonResponse({ totalFiles, totalSize: formatFileSizeStatic(totalSizeBytes), totalDownloads });
      }

      const recordMatch = path.match(/^\/api\/download\/([^/]+)\/record$/);
      if (recordMatch && request.method === "POST") {
        const fileId = decodeURIComponent(recordMatch[1]);
        const current = parseInt(await kv.get("downloads_" + fileId) || "0", 10) || 0;
        if (ctx && ctx.waitUntil) {
          ctx.waitUntil(kv.put("downloads_" + fileId, String(current + 1)).catch(() => {}));
        } else {
          await kv.put("downloads_" + fileId, String(current + 1)).catch(() => {});
        }
        return jsonResponse({ success: true });
      }

      if (path === "/api/move" && request.method === "POST") {
        const body = await readJson(request);
        if (!body) return jsonResponse({ success: false, error: "请求体不是有效 JSON" }, { status: 400 });
        const ok = await verifyAdminPassword(env, body.password || getPasswordFromHeader(request));
        if (!ok) return jsonResponse({ success: false, error: "密码错误" }, { status: 403 });
        const id = String(body.id || "");
        const metadata = await getFileMetadata(kv, id);
        if (!metadata) return jsonResponse({ success: false, error: "文件不存在" }, { status: 404 });
        metadata.folder = sanitizeFileName(body.folder || "").slice(0, 50);
        metadata.updatedAt = Date.now();
        await kv.put("meta_" + id, JSON.stringify(metadata));
        return jsonResponse({ success: true });
      }

      if (path === "/api/batch-download") {
        let ids = [];
        try {
          ids = JSON.parse(url.searchParams.get("ids") || "[]");
        } catch (_) {
          ids = [];
        }
        if (!Array.isArray(ids)) ids = [];
        ids = ids.map(String).slice(0, 100);
        const links = ids.map(id => {
          const href = "/api/download/" + encodeURIComponent(id);
          return `<p><a href="${href}" target="_blank" rel="noopener">下载：${escapeHtml(id)}</a></p>`;
        }).join("\n");
        return htmlResponse(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>批量下载</title></head><body>${links || "没有选择文件"}</body></html>`);
      }

      if (path.startsWith("/api/download/")) {
        const fileId = decodeURIComponent(path.replace("/api/download/", ""));
        const fileData = await kv.get(fileId, { type: "arrayBuffer" });
        if (!fileData) return textResponse("文件不存在", { status: 404 });
        const metadata = await getFileMetadata(kv, fileId);
        const filename = sanitizeFileName(metadata && metadata.name ? metadata.name : fileId.replace(/^\d+_[a-f0-9-]+_/, ""));
        const contentType = getMimeType(filename);
        const headers = {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=86400",
          "X-Content-Type-Options": "nosniff"
        };
        if (!isInlineImage(filename)) {
          headers["Content-Disposition"] = "attachment; filename*=UTF-8''" + encodeURIComponent(filename);
        }
        return new Response(fileData, { headers });
      }

      if (path === "/api/share" && request.method === "POST") {
        const body = await readJson(request);
        if (!body) return jsonResponse({ success: false, error: "请求体不是有效 JSON" }, { status: 400 });
        const ok = await verifyAdminPassword(env, body.password || getPasswordFromHeader(request));
        if (!ok) return jsonResponse({ success: false, error: "密码错误" }, { status: 403 });
        const id = String(body.id || "");
        const metadata = await getFileMetadata(kv, id);
        if (!metadata) return jsonResponse({ success: false, error: "文件不存在" }, { status: 404 });
        const days = Math.max(0, Math.min(parseInt(body.days, 10) || 0, 365));
        const shareId = "share_" + Date.now() + "_" + randomHex(6);
        const expireAt = days === 0 ? 0 : Date.now() + days * 24 * 60 * 60 * 1000;
        const value = JSON.stringify({ fileId: id, expireAt, createdAt: Date.now() });
        const options = days === 0 ? undefined : { expirationTtl: days * 24 * 60 * 60 };
        await kv.put(shareId, value, options);
        return jsonResponse({ success: true, shareId });
      }

      if (path.startsWith("/s/")) {
        const shareId = path.replace("/s/", "");
        if (!shareId.startsWith("share_")) return textResponse("分享链接无效", { status: 404 });
        const shareData = await kv.get(shareId, "json");
        if (!shareData) return textResponse("分享链接无效或已过期", { status: 404 });
        if (shareData.expireAt !== 0 && shareData.expireAt < Date.now()) {
          return textResponse("分享链接已过期", { status: 410 });
        }
        const fileData = await kv.get(shareData.fileId, { type: "arrayBuffer" });
        if (!fileData) return textResponse("文件已被删除", { status: 404 });
        const metadata = await getFileMetadata(kv, shareData.fileId);
        const filename = sanitizeFileName(metadata && metadata.name ? metadata.name : shareData.fileId);
        const headers = {
          "Content-Type": getMimeType(filename),
          "Cache-Control": "public, max-age=86400",
          "X-Content-Type-Options": "nosniff"
        };
        if (!isInlineImage(filename)) {
          headers["Content-Disposition"] = "attachment; filename*=UTF-8''" + encodeURIComponent(filename);
        }
        return new Response(fileData, { headers });
      }

      if (path === "/api/upload" && request.method === "POST") {
        const limited = await rateLimit(env, request, "upload", 30, 600);
        if (!limited.ok) return jsonResponse({ success: false, error: "上传过于频繁，请稍后再试" }, { status: 429, headers: { "Retry-After": String(limited.retryAfter) } });
        const formData = await request.formData();
        const password = formData.get("password") || getPasswordFromHeader(request);
        const ok = await verifyAdminPassword(env, password);
        if (!ok) return jsonResponse({ success: false, error: "密码错误" }, { status: 403 });
        const file = formData.get("file");
        if (!file || typeof file.arrayBuffer !== "function") {
          return jsonResponse({ success: false, error: "请选择文件" }, { status: 400 });
        }
        const maxFileSize = getMaxFileSize(env);
        if (file.size > maxFileSize) {
          return jsonResponse({ success: false, error: "文件过大。当前限制：" + formatFileSizeStatic(maxFileSize) }, { status: 413 });
        }
        const displayName = sanitizeFileName(file.name || "file");
        if (isBlockedFilename(displayName, env)) {
          return jsonResponse({ success: false, error: "该文件类型不允许上传：." + getExtension(displayName) }, { status: 400 });
        }
        const timestamp = Date.now();
        const fileId = timestamp + "_" + randomHex(6) + "_" + makeStorageFileName(displayName);
        const fileBuffer = await file.arrayBuffer();
        await kv.put(fileId, fileBuffer);
        await kv.put("meta_" + fileId, JSON.stringify({
          name: displayName,
          sizeBytes: file.size,
          sizeText: formatFileSizeStatic(file.size),
          size: formatFileSizeStatic(file.size), // 兼容旧前端字段
          mimeType: file.type || getMimeType(displayName),
          ext: getExtension(displayName),
          time: new Date(timestamp).toLocaleString("zh-CN"),
          uploadTime: timestamp,
          folder: ""
        }));
        return jsonResponse({ success: true, id: fileId, name: displayName, size: formatFileSizeStatic(file.size) });
      }

      if (path === "/api/delete" && request.method === "POST") {
        const body = await readJson(request);
        if (!body) return jsonResponse({ success: false, error: "请求体不是有效 JSON" }, { status: 400 });
        const ok = await verifyAdminPassword(env, body.password || getPasswordFromHeader(request));
        if (!ok) return jsonResponse({ success: false, error: "密码错误" }, { status: 403 });
        const id = String(body.id || "");
        const metadata = await getFileMetadata(kv, id);
        if (!metadata) return jsonResponse({ success: false, error: "文件不存在" }, { status: 404 });
        await kv.delete(id);
        await kv.delete("meta_" + id);
        await kv.delete("downloads_" + id);
        const deletedShares = await deleteSharesForFile(kv, id);
        return jsonResponse({ success: true, deletedShares });
      }

      if (path === "/" || path === "") {
        return htmlResponse(HTML_CONTENT);
      }

      return textResponse("Not found", { status: 404 });
    } catch (err) {
      return jsonResponse({ success: false, error: "服务器错误：" + (err && err.message ? err.message : String(err)) }, { status: 500 });
    }
  }
};
