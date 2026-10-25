/* 全能资产管家 · 多设备同步（GitHub 私密 Gist）
 * - 令牌只存本机 localStorage（am_sync_token），从不上传、不进仓库。
 * - 同步 app 的全部数据键；last-write-wins（updatedAt），覆盖前总会把被覆盖的一方备份到本机。
 */
(function () {
  'use strict';
  var FILE = 'asset-manager-data.json';
  var API = 'https://api.github.com';
  var DATA_KEYS = ['allin_finance_v1', 'invest_pnl_v3', 'invest_pnl_v2', 'wealth_assets_v2'];
  var K = {
    token: 'am_sync_token', gist: 'am_sync_gist_id', auto: 'am_sync_auto',
    localTs: 'am_sync_local_ts', lastTs: 'am_sync_last_ts', fp: 'am_sync_fp',
    lastAt: 'am_sync_last_at', lastMsg: 'am_sync_last_msg', backup: 'am_sync_backup'
  };
  var PUSH_DELAY = 2500;
  var busy = false, pushTimer = null, pending = false, reloading = false;
  var Q = window.AMQuick, lastInbox = [];   // 最近一次读取 Gist 时看到的快捷记账文件

  function g(k) { return localStorage.getItem(k); }
  function s(k, v) { localStorage.setItem(k, String(v)); }
  function num(k) { return +(g(k) || 0); }
  function token() { return (g(K.token) || '').trim(); }
  function fmtT(t) { if (!t) return '--'; var d = new Date(+t); function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }

  // ---------- local snapshot ----------
  function snapshot() { var o = {}; DATA_KEYS.forEach(function (k) { var v = g(k); if (v != null) o[k] = v; }); return o; }
  function hasData(data) {
    try { var m = JSON.parse(data['allin_finance_v1'] || '{}');
      // 忽略 app 自动生成、余额为 0 的「投资账户」
      var accs = (m.accounts || []).filter(function (a) { return !(a && a.type === 'invest' && !+a.balance); });
      if (accs.length || ['ledger', 'positions', 'history', 'dca', 'debts'].some(function (x) { return (m[x] || []).length; })) return true;
    } catch (e) {}
    return DATA_KEYS.slice(1).some(function (k) { return data[k] != null; });
  }
  // 指纹不含汇率：app 每次打开都会刷新汇率并 save()，那不算用户改动
  function fingerprint(data) {
    var o = {};
    Object.keys(data).sort().forEach(function (k) {
      if (k === 'allin_finance_v1') { try { var m = JSON.parse(data[k]); delete m.rates; o[k] = JSON.stringify(m); return; } catch (e) {} }
      o[k] = data[k];
    });
    var str = JSON.stringify(o), h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return h + ':' + str.length;
  }
  function markLocalChange() {
    var fp = fingerprint(snapshot());
    if (fp === g(K.fp)) return false;
    s(K.fp, fp); s(K.localTs, Date.now());
    return true;
  }
  function backup(source, payload) {
    try { s(K.backup, JSON.stringify({ source: source, savedAt: Date.now(), payload: payload })); } catch (e) {}
  }
  function localPayload() {
    var ts = num(K.localTs) || Date.now();
    if (!num(K.localTs)) s(K.localTs, ts);
    return { app: 'asset-manager', schema: 1, updatedAt: ts, savedFrom: (navigator.userAgent || '').slice(0, 120), data: snapshot() };
  }

  // ---------- GitHub API ----------
  function gh(method, path, body) {
    var opt = { method: method, cache: 'no-store', headers: { 'Authorization': 'Bearer ' + token(), 'Accept': 'application/vnd.github+json' } };
    if (body) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    return fetch(API + path, opt).then(function (r) {
      if (r.status === 401) throw new Error('令牌无效或已过期');
      if (r.status === 403 || r.status === 429) throw new Error('GitHub 拒绝请求（权限不足或频率限制）');
      if (r.status === 404) { var e = new Error('未找到'); e.notFound = true; throw e; }
      if (!r.ok) throw new Error('GitHub ' + r.status);
      return r.status === 204 ? null : r.json();
    });
  }
  function findGist() {
    var page = 1;
    function next() {
      return gh('GET', '/gists?per_page=100&page=' + page).then(function (list) {
        for (var i = 0; i < list.length; i++) if (list[i].files && list[i].files[FILE]) return list[i].id;
        if (list.length < 100 || page >= 10) return null;
        page++; return next();
      });
    }
    return next();
  }
  function readGist(id) {
    return gh('GET', '/gists/' + id).then(function (gist) {
      lastInbox = Object.keys(gist.files || {}).filter(function (n) { return Q && Q.isInboxName(n); }).map(function (n) { return gist.files[n]; });
      var f = gist.files && gist.files[FILE];
      if (!f) { var e = new Error('Gist 中没有数据文件'); e.notFound = true; throw e; }
      var p = (f.truncated && f.raw_url) ? fetch(f.raw_url, { cache: 'no-store' }).then(function (r) { return r.text(); }) : Promise.resolve(f.content);
      return p.then(function (txt) { var j = JSON.parse(txt || '{}'); if (!j || typeof j.data !== 'object') throw new Error('云端数据格式不对'); return j; });
    });
  }
  function createGist(payload) {
    return gh('POST', '/gists', { description: '全能资产管家 同步数据（私密，请勿公开）', public: false, files: (function () { var o = {}; o[FILE] = { content: JSON.stringify(payload) }; return o; })() })
      .then(function (gist) { s(K.gist, gist.id); return gist.id; });
  }
  function writeGist(id, payload) {
    var files = {}; files[FILE] = { content: JSON.stringify(payload) };
    return gh('PATCH', '/gists/' + id, { files: files });
  }
  // 返回 {id, remote|null}
  function locate() {
    var id = g(K.gist);
    var viaSearch = function () {
      return findGist().then(function (fid) {
        if (!fid) { localStorage.removeItem(K.gist); return { id: null, remote: null }; }
        s(K.gist, fid); return readGist(fid).then(function (r) { return { id: fid, remote: r }; });
      });
    };
    if (!id) return viaSearch();
    return readGist(id).then(function (r) { return { id: id, remote: r }; }, function (e) { if (e.notFound) return viaSearch(); throw e; });
  }

  // ---------- apply ----------
  function applyRemote(remote, why) {
    var local = snapshot();
    if (hasData(local) && fingerprint(local) !== fingerprint(remote.data)) backup('本机（被云端覆盖前）', localPayload());
    DATA_KEYS.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(remote.data, k)) localStorage.setItem(k, remote.data[k]); else localStorage.removeItem(k);
    });
    // 本机还没上传的快捷记账，合并进云端数据，不会被覆盖丢失
    var pend = Q ? Q.readPending(localStorage) : [];
    if (pend.length) { try {
      var st = JSON.parse(localStorage.getItem(DATA_KEYS[0]) || '{}'); st.accounts = st.accounts || []; st.ledger = st.ledger || [];
      if (Q.merge(st, pend).length) localStorage.setItem(DATA_KEYS[0], JSON.stringify(st));
    } catch (e) {} }
    reloading = true;
    s(K.localTs, remote.updatedAt); s(K.lastTs, remote.updatedAt); s(K.fp, fingerprint(snapshot()));
    done(why || '已从云端下载（云端 ' + fmtT(remote.updatedAt) + '）');
    setTimeout(function () { location.reload(); }, 600);
  }
  function push(id, remoteForBackup) {
    var payload = localPayload();
    if (remoteForBackup) backup('云端（被本机覆盖前）', remoteForBackup);
    var p = id ? writeGist(id, payload) : createGist(payload);
    return p.then(function () {
      s(K.lastTs, payload.updatedAt);
      if (Q) Q.prunePending(localStorage, payload.data[DATA_KEYS[0]]);
      done('已上传到云端（' + fmtT(payload.updatedAt) + '）');
    });
  }

  // ---------- 快捷记账收件箱 ----------
  // 读取 Gist 里的 quick_* 文件 → 并入账本（按 qid 去重）→ 上传账本 → 只删除已确认入账的那几个文件（期间新增的不受影响）
  function processQuick(id, allowPush) {
    if (!Q || typeof window.AMQuickApply !== 'function' || reloading) return Promise.resolve();
    var files = lastInbox.slice(); lastInbox = [];
    return Promise.all(files.map(function (f) {
      var p = (f.truncated && f.raw_url) ? fetch(f.raw_url, { cache: 'no-store' }).then(function (r) { return r.text(); }) : Promise.resolve(f.content);
      return p.then(function (c) { return { name: f.filename, entry: Q.parseEntry(f.filename, c) }; }, function () { return null; });
    })).then(function (list) {
      list = list.filter(Boolean);
      var entries = list.map(function (x) { return x.entry; }).filter(Boolean);
      if (entries.length) Q.addPending(localStorage, entries);          // 先记到本机，崩溃/刷新也不丢
      var added = window.AMQuickApply(entries.concat(Q.readPending(localStorage)));
      var fromInbox = added.filter(function (r) { return entries.some(function (e) { return e.qid === r.qid; }); }).length;
      if (fromInbox && typeof window.toast === 'function') window.toast('已导入 ' + fromInbox + ' 笔快捷记账');
      if (!allowPush || !id) return;
      clearTimeout(pushTimer); pushTimer = null;
      var needPush = Q.readPending(localStorage).length > 0;
      markLocalChange();
      if (needPush && num(K.localTs) <= num(K.lastTs)) s(K.localTs, Math.max(Date.now(), num(K.lastTs) + 1));
      var go = num(K.localTs) > num(K.lastTs) ? push(id) : Promise.resolve();
      return go.then(function () {
        var have = {}; try { (JSON.parse(snapshot()[DATA_KEYS[0]] || '{}').ledger || []).forEach(function (t) { if (t.qid) have[t.qid] = 1; }); } catch (e) {}
        // 解析失败的文件保留在 Gist，方便排查；已入账的删除
        var del = {}, n = 0;
        list.forEach(function (x) { if (x.entry && have[x.entry.qid] && Q.readPending(localStorage).every(function (e) { return e.qid !== x.entry.qid; })) { del[x.name] = null; n++; } });
        if (n) return gh('PATCH', '/gists/' + id, { files: del });
      });
    });
  }

  // ---------- flows ----------
  function run(fn) {
    if (!token()) { status('未设置令牌，同步未开启'); return Promise.resolve(); }
    if (busy) { pending = true; return Promise.resolve(); }
    busy = true; status('同步中…');
    return Promise.resolve().then(fn).catch(function (e) {
      var msg = (e && e.message) || String(e);
      if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) msg = '网络不可用，稍后自动重试';
      status('同步失败：' + msg, true);
    }).then(function () {
      busy = false;
      if (pending) { pending = false; schedulePush(200); }
    });
  }
  // 自动同步：打开时 / 回到前台 / 本地改动后
  function autoSync(interactive) {
    return run(function () {
      markLocalChange();
      return locate().then(function (res) {
        var l = num(K.localTs), last = num(K.lastTs), dirty = l > last;
        if (!res.remote) return push(null);
        var r = +res.remote.updatedAt || 0;
        // 本机从未同步且没有实际数据（只有自动生成的空「投资账户」）→ 直接下载
        if (!last && !hasData(snapshot())) return applyRemote(res.remote);
        // 首次在本机连接：两边都有数据时让用户选
        if (!last && hasData(snapshot()) && hasData(res.remote.data) && fingerprint(snapshot()) !== fingerprint(res.remote.data)) {
          if (!interactive) { status('云端和本机都有数据，请在「设置 → 多设备同步」中选择上传或下载', true); return 'hold'; }
          if (confirm('云端已有数据（' + fmtT(r) + '），本机也有数据。\n\n确定：用云端覆盖本机（本机数据会先备份）\n取消：用本机覆盖云端（云端数据会先备份）')) return applyRemote(res.remote);
          return push(res.id, res.remote);
        }
        if (r > last) {                       // 云端在上次同步后有更新
          if (!dirty || r >= l) return applyRemote(res.remote);   // 云端更新 → 下载（本机未同步改动会备份）
          // 两边都改了且本机更晚：不静默覆盖云端，让用户选（被覆盖的一方都会备份）
          if (confirm('同步冲突：上次同步后，其他设备修改了云端数据（' + fmtT(r) + '），本机也有未同步的改动（' + fmtT(l) + '）。\n\n确定：用云端覆盖本机（本机改动先备份，可在设置里恢复）\n取消：用本机覆盖云端（云端数据先备份到本机）'))
            return applyRemote(res.remote, '冲突已处理：已下载云端数据，本机改动已备份');
          return push(res.id, res.remote);
        }
        if (dirty) return push(res.id);
        s(K.lastTs, last || r);
        done('已是最新（' + fmtT(r) + '）');
      }).then(function (r) { if (r !== 'hold') return processQuick(g(K.gist), true); });
    });
  }
  // 自动同步关闭时：打开页面也把收件箱并入本机（不上传、不删除云端文件，下次按 qid 去重）
  function importOnly() {
    return run(function () { return locate().then(function (res) { if (res.remote) return processQuick(res.id, false); }); });
  }
  function manualUpload() {
    return run(function () {
      markLocalChange();
      return locate().then(function (res) {
        if (res.remote && (+res.remote.updatedAt || 0) > num(K.localTs) &&
            !confirm('云端数据（' + fmtT(res.remote.updatedAt) + '）比本机（' + fmtT(num(K.localTs)) + '）更新，确定用本机覆盖云端？\n（云端数据会先备份到本机）')) { status('已取消上传'); return; }
        s(K.localTs, Math.max(Date.now(), (res.remote && +res.remote.updatedAt || 0) + 1));
        return push(res.id, res.remote);
      });
    });
  }
  function manualDownload() {
    return run(function () {
      return locate().then(function (res) {
        if (!res.remote) { status('云端还没有数据，请先上传', true); return; }
        if (!confirm('用云端数据（' + fmtT(res.remote.updatedAt) + '）覆盖本机？\n（本机数据会先备份，可在此处恢复）')) { status('已取消下载'); return; }
        return applyRemote(res.remote);
      });
    });
  }
  function restoreBackup() {
    var b; try { b = JSON.parse(g(K.backup) || 'null'); } catch (e) {}
    if (!b || !b.payload) return;
    if (!confirm('恢复备份：' + b.source + '，备份于 ' + fmtT(b.savedAt) + '。\n当前本机数据将被替换（恢复后若开启自动同步会上传到云端）。')) return;
    var cur = localPayload();
    DATA_KEYS.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(b.payload.data, k)) localStorage.setItem(k, b.payload.data[k]); else localStorage.removeItem(k);
    });
    backup('本机（恢复备份前）', cur);
    s(K.fp, fingerprint(snapshot())); s(K.localTs, Date.now());
    location.reload();
  }
  function schedulePush(delay) {
    if (!token() || g(K.auto) !== '1') return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { autoSync(false); }, delay == null ? PUSH_DELAY : delay);
    status('有改动，稍后自动上传…');
  }

  // ---------- hook app save() ----------
  if (typeof window.save === 'function') {
    var appSave = window.save;
    // 已从云端下载、等待刷新时，忽略页面里还在跑的 save()（例如汇率刷新完成后的 save），否则会用旧的内存数据覆盖刚下载的数据
    window.save = function () { if (reloading) return; var r = appSave.apply(this, arguments); try { if (markLocalChange()) schedulePush(); } catch (e) {} return r; };
  }

  // ---------- UI ----------
  function status(msg, err) {
    var el = document.getElementById('syncStatus'); if (!el) return;
    el.textContent = msg; el.style.color = err ? 'var(--danger)' : 'var(--muted)';
  }
  function done(msg) { s(K.lastAt, Date.now()); s(K.lastMsg, msg); status(msg); refreshUI(); }
  function refreshUI() {
    var has = !!token();
    var t = document.getElementById('syncTokenState'); if (t) t.textContent = has ? '已保存（' + token().slice(0, 4) + '…' + token().slice(-4) + '）' : '未设置';
    var a = document.getElementById('syncAuto'); if (a) a.checked = g(K.auto) === '1';
    ['syncUp', 'syncDown'].forEach(function (id) { var b = document.getElementById(id); if (b) b.disabled = !has; });
    var rb = document.getElementById('syncRestoreRow'); if (rb) {
      var b = null; try { b = JSON.parse(g(K.backup) || 'null'); } catch (e) {}
      rb.style.display = b ? 'flex' : 'none';
      var lab = document.getElementById('syncRestoreLab'); if (lab && b) lab.textContent = '恢复备份（' + b.source + '，' + fmtT(b.savedAt) + '）';
    }
    if (typeof window.renderQuick === 'function') try { window.renderQuick(); } catch (e) {}
    var lt = document.getElementById('syncLast'); if (lt) lt.textContent = '上次同步：' + fmtT(num(K.lastAt)) + (g(K.gist) ? ' · Gist ' + g(K.gist).slice(0, 7) : '');
  }
  function buildUI() {
    var page = document.getElementById('p-settings'); if (!page || document.getElementById('syncCard')) return;
    var row = 'display:flex;justify-content:space-between;align-items:center;gap:8px';
    var card = document.createElement('div'); card.className = 'card'; card.id = 'syncCard';
    card.innerHTML =
      '<div class="card-t">多设备同步（GitHub 私密 Gist）</div>' +
      '<p class="hint" style="margin:0 0 8px">' +
      '1. 打开 <a href="https://github.com/settings/tokens/new?scopes=gist&description=asset-manager-sync" target="_blank" rel="noopener" style="color:var(--primary)">GitHub 创建令牌页面</a>（已自动勾选 gist 权限），有效期可选 No expiration，拉到底点 Generate token。<br>' +
      '2. 复制生成的 ghp_ 开头令牌，粘贴到下面并保存。<br>' +
      '3. 每台手机/电脑都填同一个令牌，会自动找到同一个私密 Gist（' + FILE + '）。<br>' +
      '令牌只保存在本设备浏览器里，不会被同步或上传；私密 Gist 不会公开列出，但请勿把链接分享给别人。</p>' +
      '<div class="item" style="' + row + '"><input class="form-c" id="syncToken" type="password" autocomplete="off" placeholder="粘贴 GitHub 令牌" style="flex:1">' +
      '<button class="btn-sm pri" id="syncSave">保存</button><button class="btn-sm dan" id="syncClear">清除</button></div>' +
      '<div class="item" style="' + row + '"><span>令牌</span><span id="syncTokenState" class="hint" style="margin:0"></span></div>' +
      '<div class="item" style="' + row + '"><span>自动同步（打开时拉取、改动后上传）</span><input type="checkbox" id="syncAuto" style="width:20px;height:20px"></div>' +
      '<div class="item" style="' + row + '"><span>手动同步</span><span><button class="btn-sm pri" id="syncUp">上传</button> <button class="btn-sm warn" id="syncDown">下载</button></span></div>' +
      '<div class="item" id="syncRestoreRow" style="' + row + ';display:none"><span id="syncRestoreLab" style="font-size:.8rem">恢复备份</span><button class="btn-sm" id="syncRestore">恢复</button></div>' +
      '<div id="syncStatus" style="font-size:.78rem;margin-top:6px;color:var(--muted)"></div>' +
      '<div id="syncLast" style="font-size:.7rem;color:#94a3b8;margin-top:2px"></div>';
    page.insertBefore(card, page.firstChild);
    document.getElementById('syncSave').onclick = function () {
      var v = document.getElementById('syncToken').value.trim();
      if (!v) { status('请先粘贴令牌', true); return; }
      s(K.token, v); document.getElementById('syncToken').value = '';
      if (g(K.auto) == null) s(K.auto, '1');
      refreshUI(); autoSync(true);
    };
    document.getElementById('syncClear').onclick = function () {
      if (!confirm('清除本设备上的令牌？（云端数据不受影响）')) return;
      localStorage.removeItem(K.token); localStorage.removeItem(K.gist); localStorage.removeItem(K.lastTs);
      refreshUI(); status('令牌已清除，同步已停止');
    };
    document.getElementById('syncAuto').onchange = function (e) { s(K.auto, e.target.checked ? '1' : '0'); if (e.target.checked) autoSync(true); else status('自动同步已关闭'); };
    document.getElementById('syncUp').onclick = manualUpload;
    document.getElementById('syncDown').onclick = manualDownload;
    document.getElementById('syncRestore').onclick = restoreBackup;
    refreshUI();
    status(token() ? (g(K.lastMsg) || '已设置令牌') : '未设置令牌，同步未开启');
  }

  buildUI();
  if (!g(K.fp)) { s(K.fp, fingerprint(snapshot())); }
  // 网址快捷记账在本脚本加载前已写入本机：不把它当作「冲突改动」，同步拉取后再单独上传（见 processQuick）
  if (Q && Q.readPending(localStorage).length) s(K.fp, fingerprint(snapshot()));
  if (token() && g(K.auto) === '1') autoSync(false);
  else if (token()) importOnly();
  document.addEventListener('visibilitychange', function () {
    if (!token() || g(K.auto) !== '1') return;
    if (document.visibilityState === 'hidden' && pushTimer) { clearTimeout(pushTimer); pushTimer = null; autoSync(false); }
    else if (document.visibilityState === 'visible') autoSync(false);
  });
  window.AMSync = { syncNow: function () { return autoSync(true); }, upload: manualUpload, download: manualDownload, gistId: function () { return g(K.gist) || ''; }, hasToken: function () { return !!token(); }, _keys: K, _fp: fingerprint, _snapshot: snapshot };
})();
