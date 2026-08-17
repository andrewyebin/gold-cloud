/**
 * 伦敦金云端定时更新脚本(GitHub Actions 每小时运行)
 * 职责:拉取实时金价 -> 维护 data/day.json(当日开盘/高低/差值>=30波段) -> 触发 git 提交
 * 前端页面 fetch data/day.json 渲染「当天」面板,脚本不修改 HTML,解耦稳定。
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

  // 新的一天:重置(以当日第一个快照为开盘近似)
  if (!day || day.date !== now.date) {
    day = {
      date: now.date,
      open: price,
      high: price,
      low: price,
      updatedAt: now.hm,
      bands: [],
      pend: { t: now.hm, p: price }, // 波段起点
    };
    console.log('NEW_DAY', now.date);
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
  day.updatedAt = now.hm;

  fs.writeFileSync(PATH, JSON.stringify(day, null, 2));
  console.log('OK', now.date, now.hm, price.toFixed(2), 'high=' + day.high.toFixed(1), 'low=' + day.low.toFixed(1), 'bands=' + day.bands.length);
})();
