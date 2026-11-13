/* 全能资产管家 · 快捷记账（纯函数，index.html 与 sync.js 共用；也可在 node 中测试）
 * 收件箱：同一个私密 Gist 里，每笔快捷记账是一个独立文件 quick_<时间>.txt。
 *   iOS 快捷指令只需一次 PATCH /gists/{id} 新增一个文件，不用读取、不用解析 JSON，并发也不会互相覆盖。
 * 文件内容（任选一种）：
 *   1) 多行文本：第1行金额（前面加 + 表示收入）、第2行分类、第3行备注、第4行账户（都可省略后几行）
 *   2) 一行用 | 分隔：38|餐饮|午饭
 *   3) JSON：{"amount":38,"type":"expense","category":"餐饮","note":"午饭","account":"支付宝","date":"2026-10-25"}
 */
(function (root) {
  'use strict';
  var PREFIX = 'quick_';
  var PENDING = 'am_quick_pending';   // 本机已入账、但还没确认上传到云端的快捷记账
  var CATS = ['餐饮', '交通', '购物', '日用', '娱乐', '住房', '医疗', '通讯', '人情', '其他'];
  var INCOME_CATS = ['工资', '奖金', '理财', '退款', '其他收入'];

  function pad(n) { return String(n).padStart(2, '0'); }
  function todayStr(d) { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseAmount(v) {
    if (typeof v === 'number') return v;
    var s = String(v == null ? '' : v).replace(/[,，\s]/g, '');
    var m = s.match(/[-+]?\d+(?:\.\d+)?/);
    return m ? +m[0] : NaN;
  }
  function dateFromName(name) {
    var m = String(name || '').match(/(20\d\d)-?(\d\d)-?(\d\d)/);
    return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
  }
  function isInboxName(name) { return String(name || '').indexOf(PREFIX) === 0; }
  // 把一个收件箱文件解析成标准条目；解析不出金额返回 null
  function parseEntry(id, content, fallbackDate) {
    var txt = String(content == null ? '' : content).trim(), o = null;
    if (/^\{/.test(txt)) { try { o = JSON.parse(txt); } catch (e) { o = null; } }
    if (!o) {
      var parts = txt.indexOf('\n') >= 0 ? txt.split(/\r?\n/) : txt.split('|');
      parts = parts.map(function (x) { return x.trim(); });
      o = { amount: parts[0], category: parts[1], note: parts[2], account: parts[3] };
    }
    var raw = o.amount != null ? o.amount : (o.amt != null ? o.amt : o.money);
    var amt = parseAmount(raw);
    if (!isFinite(amt) || amt === 0) return null;
    var type = o.type === 'income' || o.type === '收入' ? 'income' : (o.type === 'expense' || o.type === '支出' ? 'expense' : null);
    if (!type) type = /^\s*\+/.test(String(raw)) ? 'income' : 'expense';
    var cat = String(o.category || o.cat || '').trim();
    if (!o.type && INCOME_CATS.indexOf(cat) >= 0) type = 'income';
    var date = String(o.date || '').match(/^\d{4}-\d\d-\d\d$/) ? o.date : (dateFromName(id) || fallbackDate || todayStr());
    return { qid: String(o.id || id), amount: Math.round(Math.abs(amt) * 100) / 100, type: type, category: cat,
      note: String(o.note || o.merchant || '').trim(), account: String(o.account || o.acc || '').trim(), date: date };
  }
  function plainAccounts(state) {
    return (state.accounts || []).filter(function (x) { return !(x && (x.type === 'invest' || x.name === '投资账户' || x.type === 'fx')); });
  }
  function matchAccount(state, name) {
    var accs = plainAccounts(state);
    if (!name) return null;
    return accs.find(function (x) { return x.name === name; }) || accs.find(function (x) { return x.name && (x.name.indexOf(name) >= 0 || name.indexOf(x.name) >= 0); }) || null;
  }
  function pickAccount(state, name) {
    // 快捷记账只动普通账户。投资账户的闲钱由买卖和互转记账，避免把入金出金记成收支
    var accs = plainAccounts(state);
    if (name) {
      var a = accs.find(function (x) { return x.name === name; }) || accs.find(function (x) { return x.name && (x.name.indexOf(name) >= 0 || name.indexOf(x.name) >= 0); });
      if (a) return a;
    }
    if (state.quickAccId) { var d = accs.find(function (x) { return x.id === state.quickAccId; }); if (d) return d; }
    return accs[0] || null;
  }
  // 把条目合并进 app 状态（与「记一笔」完全相同的记录格式与余额变化）。按 qid 去重。返回新增的记录数组。
  function merge(state, entries, now) {
    state.ledger = state.ledger || [];
    var seen = {}; state.ledger.forEach(function (t) { if (t && t.qid) seen[t.qid] = 1; });
    var added = [];
    (entries || []).forEach(function (e, i) {
      if (!e || !e.qid || seen[e.qid]) return;
      seen[e.qid] = 1;
      var acc = pickAccount(state, e.account);
      if (acc) {
        if (e.type === 'expense') acc.balance = (+acc.balance || 0) - e.amount;
        else if (e.type === 'income') acc.balance = (+acc.balance || 0) + e.amount;
      }
      var note = [e.category, e.note].filter(Boolean).join(' · ');
      var rec = { id: (now || Date.now()).toString(36) + i + Math.random().toString(36).slice(2, 6), type: e.type, amount: e.amount,
        accId: acc ? acc.id : '', note: note, date: e.date || todayStr(), createdAt: (now || Date.now()) + i, qid: e.qid, src: 'quick' };
      state.ledger.unshift(rec); added.push(rec);
    });
    return added;
  }
  function readPending(ls) { try { var a = JSON.parse(ls.getItem(PENDING) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function writePending(ls, arr) { if (arr.length) ls.setItem(PENDING, JSON.stringify(arr)); else ls.removeItem(PENDING); }
  function addPending(ls, entries) {
    var cur = readPending(ls), ids = {}; cur.forEach(function (e) { ids[e.qid] = 1; });
    entries.forEach(function (e) { if (!ids[e.qid]) { cur.push(e); ids[e.qid] = 1; } });
    writePending(ls, cur);
  }
  // 去掉已经确认在 data（allin_finance_v1 的 JSON 字符串）里的条目
  function prunePending(ls, dataStr) {
    var have = {}; try { (JSON.parse(dataStr || '{}').ledger || []).forEach(function (t) { if (t && t.qid) have[t.qid] = 1; }); } catch (e) {}
    writePending(ls, readPending(ls).filter(function (e) { return !have[e.qid]; }));
  }
  function newId() { var d = new Date(); return PREFIX + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '-' + Math.random().toString(36).slice(2, 7); }

  var EXP_RULES = [
    ['餐饮', /餐|咖啡|奶茶|美团|饿了么|星巴克|瑞幸|肯德基|麦当劳|外卖|饭店|餐厅|食堂|喜茶|奈雪|汉堡|烧烤|火锅|面馆|小吃/],
    ['交通', /地铁|滴滴|公交|加油|停车|高铁|火车|出租|单车|哈啰|打车|高速|机票|航空|曹操|神州/],
    ['购物', /淘宝|京东|拼多多|超市|便利|天猫|唯品会|商场|盒马|沃尔玛|永辉|山姆/],
    ['娱乐', /电影|游戏|视频|爱奇艺|腾讯视频|bilibili|b站|KTV|ktv|门票/i],
    ['住房', /房租|租金|水费|电费|燃气|物业/],
    ['医疗', /医院|药店|挂号|医保|诊所|药房/],
    ['通讯', /话费|流量|中国移动|中国联通|中国电信/],
    ['日用', /日用|洗衣|理发/],
    ['人情', /红包|礼金|随礼/]
  ];
  var INC_RULES = [
    ['工资', /工资|薪水|月薪|薪资/],
    ['奖金', /奖金|年终奖/],
    ['退款', /退款|退回/],
    ['理财', /理财|利息|收益/]
  ];
  function normOcr(text) {
    return String(text == null ? '' : text).replace(/\r/g, '').replace(/[ \t]+/g, ' ')
      .replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, '$1');
  }
  function ocrLines(text) {
    return normOcr(text).split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function guessPayType(text) {
    if (/支付成功|付款成功|支付完成|付款完成|交易成功|转账成功/.test(text)) return 'expense';
    if (/收款成功|已收款|你已收款|收款到账|工资到账/.test(text)) return 'income';
    if (/到账|收款/.test(text) && !/支付|付款/.test(text)) return 'income';
    return 'expense';
  }
  function lineAmounts(line) {
    var s = line.replace(/\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?/g, ' ').replace(/[,，\s]/g, '');
    var re = /(?:¥|￥)?([-+])?(\d{1,8}(?:\.\d{1,2})?)(?!\d)/g, out = [], m;
    while ((m = re.exec(s))) {
      var n = +m[2];
      if (!isFinite(n) || n <= 0) continue;
      if (!/[¥￥]/.test(m[0]) && !/\./.test(m[2]) && n >= 1990 && n <= 2100) continue;
      out.push(Math.round(n * 100) / 100);
    }
    return out;
  }
  function ignoredAmountLine(line) {
    return /余额|优惠|立减|折扣|原价|积分|抵扣|券/.test(line) && !/实付|支付金额|付款金额/.test(line);
  }
  function onlyAmount(line) {
    return /^(?:[#¥￥]|RMB|CNY)?[-+]?\d+(?:\.\d{1,2})?元?$/.test(line.replace(/[,，\s]/g, ''));
  }
  function pickPayAmount(lines) {
    var best = null, score = -1, skipNext = false;
    lines.forEach(function (line, i) {
      if (skipNext && (onlyAmount(line) || lineAmounts(line).length)) { skipNext = false; return; }
      skipNext = false;
      if (/^(优惠|立减|折扣|原价|余额|积分|抵扣|零钱余额)$/.test(line)) { skipNext = true; return; }
      if (ignoredAmountLine(line)) return;
      var amts = lineAmounts(line);
      if (!amts.length) return;
      var base = 10;
      if (/实付/.test(line)) base = 100;
      else if (/支付金额|付款金额/.test(line)) base = 90;
      else if (onlyAmount(line) && i < 8) base = 70;
      else if (/订单金额|金额/.test(line)) base = 40;
      else if (i < 6) base = 30;
      amts.forEach(function (n) {
        var sc = base + (String(n).indexOf('.') >= 0 ? 1 : 0);
        if (sc > score) { score = sc; best = n; }
      });
    });
    return best;
  }
  function guessMerchant(lines) {
    var label = /^(收款方|商户名称|商户|商家|商品|对方|收款人|店铺|来自)\s*[:：]?\s*(.*)$/;
    var skip = /支付成功|付款成功|收款成功|交易成功|转账成功|微信支付|支付宝|支付方式|付款方式|支付时间|完成|查看账单|零钱|到账|已到账|优惠|原价|余额/;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(label);
      if (!m) continue;
      var rest = (m[2] || '').trim();
      if (rest && !onlyAmount(rest) && !skip.test(rest)) return rest.slice(0, 40);
      var next = lines[i + 1] || '';
      if (next && !onlyAmount(next) && !skip.test(next) && !label.test(next)) return next.slice(0, 40);
    }
    for (i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (skip.test(line) || onlyAmount(line) || label.test(line) || ignoredAmountLine(line)) continue;
      if (/支付|付款|收款|微信|支付宝|银行|储蓄卡|信用卡/.test(line) && line.length < 8) continue;
      return line.slice(0, 40);
    }
    return '';
  }
  function guessAccount(text) {
    var head = text.slice(0, 40);
    if (/微信支付/.test(text) || (/微信/.test(head) && !/支付宝/.test(head))) return '微信';
    if (/支付宝/.test(text)) return '支付宝';
    if (/银行|储蓄卡|信用卡|银联/.test(text)) return '银行卡';
    return '';
  }
  function guessCategory(text, type) {
    var rules = type === 'income' ? INC_RULES : EXP_RULES;
    for (var i = 0; i < rules.length; i++) if (rules[i][1].test(text)) return rules[i][0];
    return type === 'income' ? '其他收入' : '其他';
  }
  function pickPayDate(text) {
    var m = text.match(/(20\d\d)\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
    if (!m) return '';
    return m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
  }
  // 支付成功截图的 OCR 文本 → 预填字段。不写账，交给用户确认。
  function parsePayOcr(text) {
    var raw = normOcr(text), lines = ocrLines(raw);
    var type = guessPayType(raw);
    var amount = pickPayAmount(lines);
    var merchant = guessMerchant(lines);
    return {
      amount: amount,
      type: type,
      merchant: merchant,
      category: guessCategory(raw + '\n' + merchant, type),
      account: guessAccount(raw),
      note: merchant,
      date: pickPayDate(raw)
    };
  }

  var TESS_JS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  var TESS_WORKER = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js';
  var TESS_CORE = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1';
  var TESS_LANG = 'https://tessdata.projectnaptha.com/4.0.0';
  var tessLoading = null, payWorker = null, payStatus = function () {};
  function loadTesseract() {
    if (root.Tesseract) return Promise.resolve(root.Tesseract);
    if (tessLoading) return tessLoading;
    tessLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = TESS_JS; s.async = true;
      s.onload = function () { root.Tesseract ? resolve(root.Tesseract) : reject(new Error('识别引擎没有就绪')); };
      s.onerror = function () { tessLoading = null; reject(new Error('识别引擎下载失败，请检查网络')); };
      document.head.appendChild(s);
    });
    return tessLoading;
  }
  function ocrStatusText(m) {
    var p = m && isFinite(+m.progress) ? Math.round(m.progress * 100) : null;
    var pct = p == null ? '' : ' ' + p + '%';
    var s = (m && m.status) || '';
    if (/language|traineddata/.test(s)) return '正在下载识别字库（只需一次）' + pct;
    if (/core|tesseract/.test(s) && !/recogniz/.test(s)) return '正在加载识别引擎' + pct;
    if (/recogniz/.test(s)) return '正在识别' + pct;
    return '正在准备' + pct;
  }
  function warmOcrFiles() {
    var urls = [TESS_JS, TESS_WORKER, TESS_CORE + '/tesseract-core-lstm.wasm.js', TESS_LANG + '/chi_sim.traineddata.gz', TESS_LANG + '/eng.traineddata.gz'];
    return Promise.all(urls.map(function (u) { return fetch(u, { mode: 'cors' }).catch(function () { return null; }); }));
  }
  function recognizePayImage(file, onStatus) {
    payStatus = typeof onStatus === 'function' ? onStatus : function () {};
    payStatus({ status: 'loading tesseract core', progress: 0 });
    var prep = payWorker ? Promise.resolve(payWorker) : warmOcrFiles().then(loadTesseract).then(function (T) {
      return T.createWorker('chi_sim+eng', 1, {
        workerPath: TESS_WORKER,
        corePath: TESS_CORE,
        langPath: TESS_LANG,
        logger: function (m) { payStatus(m); }
      });
    });
    if (!payWorker) payWorker = prep;
    return prep.then(function (worker) {
      payWorker = worker;
      return worker.recognize(file).then(function (res) {
        var text = (res && res.data && res.data.text) || '';
        var parsed = parsePayOcr(text);
        parsed.text = text;
        return parsed;
      });
    }, function (e) { payWorker = null; throw e; });
  }
  function bindPayOcr(opts) {
    var btn = document.getElementById(opts.button), file = document.getElementById(opts.file), hint = document.getElementById(opts.hint);
    if (!btn || !file || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      btn.disabled = true;
      var t0 = Date.now();
      if (hint) hint.textContent = '正在准备识别…首次会下载中文字库';
      recognizePayImage(f, function (m) { if (hint) hint.textContent = ocrStatusText(m); }).then(function (r) {
        r.ms = Date.now() - t0;
        btn.dataset.ms = String(r.ms);
        if (opts.apply) opts.apply(r);
        if (hint) hint.textContent = r.amount ? '已识别，请确认' : '没有识别到金额，请确认后手工填写';
      }, function (e) {
        if (hint) hint.textContent = '识别失败：' + ((e && e.message) || '请换一张更清晰的截图');
      }).then(function () { btn.disabled = false; });
    });
  }

  var api = { PREFIX: PREFIX, PENDING: PENDING, CATS: CATS, INCOME_CATS: INCOME_CATS, parseEntry: parseEntry, parseAmount: parseAmount,
    parsePayOcr: parsePayOcr, recognizePayImage: recognizePayImage, bindPayOcr: bindPayOcr, ocrStatusText: ocrStatusText, matchAccount: matchAccount,
    isInboxName: isInboxName, merge: merge, pickAccount: pickAccount, readPending: readPending, writePending: writePending,
    addPending: addPending, prunePending: prunePending, newId: newId, todayStr: todayStr };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AMQuick = api;
})(typeof window !== 'undefined' ? window : this);
