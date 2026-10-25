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
  function pickAccount(state, name) {
    var accs = (state.accounts || []);
    if (name) {
      var a = accs.find(function (x) { return x.name === name; }) || accs.find(function (x) { return x.name && (x.name.indexOf(name) >= 0 || name.indexOf(x.name) >= 0); });
      if (a) return a;
    }
    if (state.quickAccId) { var d = accs.find(function (x) { return x.id === state.quickAccId; }); if (d) return d; }
    return accs.find(function (x) { return x.type !== 'invest'; }) || null;
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
      if (acc && acc.type !== 'invest') {
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

  var api = { PREFIX: PREFIX, PENDING: PENDING, CATS: CATS, INCOME_CATS: INCOME_CATS, parseEntry: parseEntry, parseAmount: parseAmount,
    isInboxName: isInboxName, merge: merge, pickAccount: pickAccount, readPending: readPending, writePending: writePending,
    addPending: addPending, prunePending: prunePending, newId: newId, todayStr: todayStr };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AMQuick = api;
})(typeof window !== 'undefined' ? window : this);
