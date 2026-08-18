/**
 * 伦敦金云端定时更新脚本(GitHub Actions 每小时运行)
 * 职责:拉取实时金价 -> 维护 data/day.json(当日开盘/高低/差值>=30波段/自动生成走势规律) -> 触发 git 提交
 * 前端页面 fetch data/day.json 渲染「当天」面板(概况/波段/规律),脚本不修改 HTML,解耦稳定。
 * 交易时段外(北京时间 0:00-5:59)或周末:直接退出,不产生提交。
 */
const fs = require('fs');
const PATH = 'data/day.json';
const API = 'https://api.gold-api.com/price/XAU';
const BAND_MIN = 30; // 差值>=30 记一段波段

function bj() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 转北京时间
  return {
    date: d.toISOString().slice(0, 10),
    hm: String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'),
    dow: d.getUTCDay(), // 0=周日, 6=周六
  };
}

// 规则引擎:基于当日数据生成走势规律(客观数据描述,不编造原因)
function buildRules(day) {
  const r = [];
  const price = day.price;
  const open = day.open, high = day.high, low = day.low, prevClose = day.prevClose;
  if (!isFinite(open) || !isFinite(high) || !isFinite(low) || !isFinite(price)) return r;
  const span = high - low;

  // 1. 开盘定性(与昨收比)
  if (isFinite(prevClose)) {
    const gap = open - prevClose;
    if (gap > 3) r.push('高开 ' + gap.toFixed(1) + ' 美元,较昨收 ' + prevClose.toFixed(1) + ' 走强,开盘情绪偏多');
    else if (gap < -3) r.push('低开 ' + (-gap).toFixed(1) + ' 美元,较昨收 ' + prevClose.toFixed(1) + ' 走弱,开盘承压');
    else r.push('平开,与昨收 ' + prevClose.toFixed(1) + ' 基本持平,开盘方向未明');
  } else {
    r.push('今日开盘 ' + open.toFixed(1) + '(无昨收参考,以首个快照近似)');
  }

  // 2. 现价 vs 开盘
  const dO = price - open;
  if (Math.abs(dO) < 0.05) r.push('现价 ' + price.toFixed(1) + ',与开盘基本持平');
  else r.push('现价 ' + price.toFixed(1) + ',较开盘' + (dO >= 0 ? '上涨' : '下跌') + Math.abs(dO).toFixed(1) + ' 美元');

  // 3. 日内波幅(首笔快照时波幅尚未积累)
  if (span < 0.5) r.push('日内波幅待积累(开盘不久),行情刚启动');
  else r.push('日内波幅 ' + span.toFixed(1) + ' 美元,区间 ' + low.toFixed(1) + '–' + high.toFixed(1));

  // 4. 波段总结(差值>=30)
  const bands = day.bands || [];
  const ups = bands.filter(function (b) { return b.dir === 'up'; }).length;
  const downs = bands.length - ups;
  if (bands.length === 0) r.push('今日暂无 ≥' + BAND_MIN + ' 美元波段(波动未达阈值),走势以窄幅整理为主');
  else if (ups > downs) r.push('今日已出现 ' + bands.length + ' 段 ≥' + BAND_MIN + ' 美元波段(涨 ' + ups + ' / 跌 ' + downs + '),方向偏多');
  else if (downs > ups) r.push('今日已出现 ' + bands.length + ' 段 ≥' + BAND_MIN + ' 美元波段(涨 ' + ups + ' / 跌 ' + downs + '),方向偏空');
  else r.push('今日已出现 ' + bands.length + ' 段 ≥' + BAND_MIN + ' 美元波段,涨跌各半,多空拉锯');

  // 5. 现价位置(区间百分比)
  if (span > 0) {
    const pos = (price - low) / span;
    const dHigh = high - price, dLow = price - low;
    if (dHigh < 0.05) r.push('现价 ' + price.toFixed(1) + ' 即今日最高点,盘中偏强');
    else if (pos > 0.66) r.push('现价贴近今日高点(距高 ' + dHigh.toFixed(1) + '),短线偏强');
    else if (dLow < 0.05) r.push('现价 ' + price.toFixed(1) + ' 即今日最低点,盘中偏弱');
    else if (pos < 0.33) r.push('现价贴近今日低点(距低 ' + dLow.toFixed(1) + '),短线偏弱');
    else r.push('现价位于今日区间中段(约 ' + Math.round(pos * 100) + '% 位置),多空均衡');
  }
  return r;
}

(async () => {
  const now = bj();
  const hour = parseInt(now.hm.slice(0, 2), 10);
  const inSession = (hour >= 6 && hour <= 23) && (now.dow >= 1 && now.dow <= 5);
  if (!inSession) {
    console.log('OUT_OF_SESSION', now.date, now.hm, 'weekday=' + now.dow);
    process.exit(0);
  }

  let resp;
  try {
    resp = await fetch(API);
  } catch (e) {
    console.log('FETCH_FAIL', e.message);
    process.exit(0);
  }
  if (!resp.ok) {
    console.log('HTTP', resp.status);
    process.exit(0);
  }
  const j = await resp.json();
  const price = Number(j.price);
  if (!isFinite(price)) {
    console.log('BAD_PRICE');
    process.exit(0);
  }

  let day = null;
  if (fs.existsSync(PATH)) {
    try { day = JSON.parse(fs.readFileSync(PATH, 'utf8')); } catch (e) { day = null; }
  }

  // 新的一天:重置;昨收 = 旧数据最后价(优先 price,其次 high)
  if (!day || day.date !== now.date) {
    const prev = day && isFinite(day.price) ? day.price : (day && isFinite(day.high) ? day.high : null);
    day = {
      date: now.date,
      prevClose: prev,
      open: price,
      high: price,
      low: price,
      price: price,
      updatedAt: now.hm,
      bands: [],
      pend: { t: now.hm, p: price },
    };
    console.log('NEW_DAY', now.date, 'prevClose=' + (prev !== null ? prev.toFixed(1) : 'n/a'));
  }

  // 波段识别:从 pend(段起点)算起,累计差值>=30 即记一段,起点重置
  const pend = day.pend || null;
  if (pend && isFinite(pend.p)) {
    const delta = price - pend.p;
    if (Math.abs(delta) >= BAND_MIN) {
      day.bands.push({
        startT: pend.t,
        startP: Number(pend.p.toFixed(1)),
        endT: now.hm,
        endP: Number(price.toFixed(1)),
        dir: delta > 0 ? 'up' : 'down',
        delta: Math.round(Math.abs(delta)),
      });
      day.pend = { t: now.hm, p: price };
    }
  } else {
    day.pend = { t: now.hm, p: price };
  }

  day.high = Math.max(day.high, price);
  day.low = Math.min(day.low, price);
  if (!isFinite(day.open)) day.open = price;
  day.price = price;
  day.updatedAt = now.hm;
  day.rules = buildRules(day);

  fs.writeFileSync(PATH, JSON.stringify(day, null, 2));
  console.log('OK', now.date, now.hm, price.toFixed(2), 'high=' + day.high.toFixed(1), 'low=' + day.low.toFixed(1), 'bands=' + day.bands.length, 'rules=' + day.rules.length);
})();
