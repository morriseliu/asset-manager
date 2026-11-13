/* node quick-ocr.test.js */
var Q = require('./quick.js');
var samples = [
  ['微信星巴克', '微信支付\n支付成功\n¥2.00\n收款方\n星巴克\n支付方式\n零钱\n支付时间\n2026-11-13 14:02:11',
    { amount: 2, type: 'expense', merchant: '星巴克', category: '餐饮', account: '微信', date: '2026-11-13' }],
  ['微信美团', '微信支付\n支付成功\n-36.80\n收款方\n美团外卖',
    { amount: 36.8, type: 'expense', merchant: '美团外卖', category: '餐饮', account: '微信' }],
  ['支付宝盒马忽略优惠原价', '支付宝\n付款成功\n￥128.00\n收款方\n盒马鲜生\n优惠\n¥10.00\n原价\n¥138.00',
    { amount: 128, type: 'expense', merchant: '盒马鲜生', category: '购物', account: '支付宝' }],
  ['瑞幸实付', '瑞幸咖啡\n实付金额\n15.50\n原价\n20.00',
    { amount: 15.5, type: 'expense', merchant: '瑞幸咖啡', category: '餐饮', account: '' }],
  ['地铁', '微信支付\n支付成功\n¥4.00\n收款方\n上海地铁',
    { amount: 4, type: 'expense', merchant: '上海地铁', category: '交通', account: '微信' }],
  ['滴滴', '支付宝\n支付成功\n¥23.60\n滴滴出行',
    { amount: 23.6, type: 'expense', merchant: '滴滴出行', category: '交通', account: '支付宝' }],
  ['京东', '支付宝\n付款成功\n支付金额 ¥299.00\n商品\n京东商城\n优惠 ¥20',
    { amount: 299, type: 'expense', merchant: '京东商城', category: '购物', account: '支付宝' }],
  ['工资到账', '微信\n收款成功\n+2000.00\n来自\n公司工资\n已到账\n2026年11月13日',
    { amount: 2000, type: 'income', merchant: '公司工资', category: '工资', account: '微信', date: '2026-11-13' }],
  ['医院挂号', '付款金额\n50.00\n收款方\n市第一医院\n挂号',
    { amount: 50, type: 'expense', merchant: '市第一医院', category: '医疗', account: '' }],
  ['话费', '支付宝\n支付成功\n￥100\n中国移动话费充值',
    { amount: 100, type: 'expense', merchant: '中国移动话费充值', category: '通讯', account: '支付宝' }],
  ['房租银行卡', '转账成功\n¥3000.00\n收款方\n房东\n招商银行储蓄卡\n房租',
    { amount: 3000, type: 'expense', merchant: '房东', category: '住房', account: '银行卡' }],
  ['忽略余额', '微信支付\n支付成功\n¥8.50\n零钱余额\n¥1234.56\n收款方\n便利蜂',
    { amount: 8.5, type: 'expense', merchant: '便利蜂', category: '购物', account: '微信' }],
  ['OCR空格微信', '支 付 成 功\n¥2.00\n收 款 方\n星 巴 克\n微 信 支 付',
    { amount: 2, type: 'expense', merchant: '星巴克', category: '餐饮', account: '微信' }],
  ['OCR空格支付宝', '支 付 宝\n付 款 或 功\n# 128.00\n收 款 方\n盒 马 鲜 生\n优 惠\n¥10.00\n原 价\n¥138.00',
    { amount: 128, type: 'expense', merchant: '盒马鲜生', category: '购物', account: '支付宝' }]
];
var failed = 0;
samples.forEach(function (s) {
  var got = Q.parsePayOcr(s[1]);
  var want = s[2];
  var bad = [];
  Object.keys(want).forEach(function (k) {
    if (got[k] !== want[k]) bad.push(k + ' 期望 ' + JSON.stringify(want[k]) + ' 得到 ' + JSON.stringify(got[k]));
  });
  if (bad.length) { failed++; console.log('FAIL ' + s[0] + '\n  ' + bad.join('\n  ')); }
  else console.log('OK   ' + s[0]);
});
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('ALL ' + samples.length + ' PASSED');
