#!/usr/bin/env node
// ───────────────────────────────────────────────────────────
// 雲端重算腳本(GitHub Actions 用)
// 讀 repo data/daily/*.json,用收盤序列重算週/月布林、波段/長線族群、標籤,寫回 repo。
// 完全在 GitHub 伺服器執行,不依賴手機/瀏覽器,不會因裝置凍結而中斷。
//
// 環境變數:
//   GITHUB_TOKEN  - Actions 自動提供(讀寫 repo)
//   GITHUB_REPOSITORY - Actions 自動提供(owner/repo)
// ───────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO  = process.env.GITHUB_REPOSITORY;   // e.g. "x8806080/stockbuy"
const BRANCH = process.env.TARGET_BRANCH || 'main';
const HIST_DIR = 'data/daily';
const INDEX_FILE = 'data/daily/index.json';

if (!TOKEN || !REPO) { console.error('缺少 GITHUB_TOKEN 或 GITHUB_REPOSITORY'); process.exit(1); }
const [OWNER, REPO_NAME] = REPO.split('/');
const API = `https://api.github.com/repos/${OWNER}/${REPO_NAME}`;

// ── GitHub API 小工具 ──
async function gh(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  return r;
}
async function getJSON(repoPath) {
  // 用 contents API 拿檔案(含 sha),解 base64
  const r = await gh(`${API}/contents/${repoPath}?ref=${BRANCH}`);
  if (!r.ok) { if (r.status === 404) return null; throw new Error(`GET ${repoPath} ${r.status}`); }
  const j = await r.json();
  const content = Buffer.from(j.content, 'base64').toString('utf8');
  return { data: JSON.parse(content), sha: j.sha };
}
async function putJSON(repoPath, obj, sha, message) {
  const body = {
    message: message || `update ${repoPath}`,
    content: Buffer.from(JSON.stringify(obj)).toString('base64'),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await gh(`${API}/contents/${repoPath}`, { method: 'PUT', body: JSON.stringify(body) });
    if (r.ok) return await r.json();
    if (r.status === 409 || r.status === 422) {
      // sha 衝突 → 重抓 sha 再試
      const cur = await getJSON(repoPath).catch(() => null);
      if (cur) body.sha = cur.sha;
      await new Promise(res => setTimeout(res, 400 * (attempt + 1)));
      lastErr = `${r.status} retry`;
      continue;
    }
    lastErr = `PUT ${repoPath} ${r.status}: ${await r.text()}`;
    break;
  }
  throw new Error(lastErr || 'putJSON failed');
}

// ── 從 index.html 抽取 STOCK_DICT(字典只維護一份) ──
function loadStockDict() {
  const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
  const m = html.match(/const STOCK_DICT = (\{.*?\});/s);
  if (!m) { console.warn('index.html 找不到 STOCK_DICT,族群將缺產業'); return {}; }
  return JSON.parse(m[1]);
}

// ── 布林計算(與網頁版一致) ──
function weekKeyOf(dk) {
  const y = +dk.slice(0,4), m = +dk.slice(4,6), d = +dk.slice(6,8);
  const date = new Date(y, m-1, d);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return date.getFullYear() + String(date.getMonth()+1).padStart(2,'0') + String(date.getDate()).padStart(2,'0');
}
function monthKeyOf(dk) { return dk.slice(0,6); }

function computeWeeklyBollinger(hist, period=20, k=2) {
  const out = {};
  for (const sym in hist) {
    const arr = hist[sym];
    if (!arr || arr.length < period*3) continue;
    const wm = {};
    arr.forEach(({dk, close}) => { if (close>0) wm[weekKeyOf(dk)] = close; });
    const wc = Object.keys(wm).sort().map(w => wm[w]);
    if (wc.length < period) continue;
    const recent = wc.slice(-period);
    const sma = recent.reduce((a,b)=>a+b,0)/period;
    const std = Math.sqrt(recent.reduce((a,b)=>a+(b-sma)**2,0)/period);
    const upper = sma + k*std;
    const weekClose = wc[wc.length-1];
    out[sym] = { upper, sma, std, weekClose, aboveUpper: weekClose > upper };
  }
  return out;
}
function computeMonthlyBollinger(hist, period=20, k=2) {
  const out = {};
  for (const sym in hist) {
    const arr = hist[sym];
    if (!arr || arr.length < period*15) continue;
    const mm = {};
    arr.forEach(({dk, close}) => { if (close>0) mm[monthKeyOf(dk)] = close; });
    const mc = Object.keys(mm).sort().map(m => mm[m]);
    if (mc.length < period) continue;
    const recent = mc.slice(-period);
    const sma = recent.reduce((a,b)=>a+b,0)/period;
    const std = Math.sqrt(recent.reduce((a,b)=>a+(b-sma)**2,0)/period);
    const upper = sma + k*std;
    const monthClose = mc[mc.length-1];
    out[sym] = { upper, sma, std, monthClose, aboveUpper: monthClose > upper };
  }
  return out;
}

const splitI = s => (s||'').split(/[,、，;；/]/).map(x=>x.trim()).filter(Boolean);

// ── 主流程 ──
async function main() {
  console.log(`▶ 雲端重算開始 repo=${REPO} branch=${BRANCH}`);
  const STOCK_DICT = loadStockDict();
  console.log(`  字典 ${Object.keys(STOCK_DICT).length} 檔`);

  // 讀日期索引
  const idxRes = await getJSON(INDEX_FILE);
  const allDates = (idxRes?.data || []).slice().sort();
  if (!allDates.length) { console.error('無歷史資料(index.json 空)'); process.exit(1); }
  console.log(`  共 ${allDates.length} 個日期`);

  const bollHist = {};
  let ok = 0, fail = 0;

  for (let i = 0; i < allDates.length; i++) {
    const dk = allDates[i];
    let res;
    try { res = await getJSON(`${HIST_DIR}/${dk}.json`); }
    catch (e) { fail++; console.warn(`  ${dk} 讀取失敗:${e.message}`); continue; }
    if (!res || !res.data || !res.data.priceMap) { continue; }
    const payload = res.data;

    // 累積收盤序列
    for (const sym in payload.priceMap) {
      const c = payload.priceMap[sym];
      if (c > 0) {
        if (!bollHist[sym]) bollHist[sym] = [];
        bollHist[sym].push({ dk, close: c });
        if (bollHist[sym].length > 460) bollHist[sym] = bollHist[sym].slice(-460);
      }
    }
    // 算布林
    const bollMap = computeWeeklyBollinger(bollHist, 20, 2);
    const mbollMap = computeMonthlyBollinger(bollHist, 20, 2);
    const bollUp = Object.keys(bollMap).filter(s => bollMap[s].aboveUpper);
    const mbollUp = Object.keys(mbollMap).filter(s => mbollMap[s].aboveUpper);
    payload.bollUp = bollUp;
    payload.mbollUp = mbollUp;

    // 族群統計
    const corpMap = {};
    (payload.top50||[]).forEach(r => { corpMap[r.代號] = r.三大法人5日買超 || 0; });
    const tally = syms => {
      const m = {};
      syms.forEach(sym => {
        const ind = (STOCK_DICT[sym] && STOCK_DICT[sym].i) || '';
        splitI(ind).forEach(i => { if(!m[i]) m[i]={ind:i,count:0,corp:0}; m[i].count++; m[i].corp += (corpMap[sym]||0); });
      });
      return Object.entries(m).sort((a,b)=>(b[1].count-a[1].count)||(b[1].corp-a[1].corp)).slice(0,8).map(([k,v])=>({ind:k,count:v.count,corp:v.corp}));
    };
    payload.waveInds = tally(bollUp);
    payload.moonInds = tally(mbollUp);

    // 更新 top50 旗標+標籤
    const top5Wave = new Set(payload.waveInds.slice(0,5).map(d=>d.ind));
    const top5Moon = new Set(payload.moonInds.slice(0,5).map(d=>d.ind));
    const bollUpSet = new Set(bollUp), mbollUpSet = new Set(mbollUp);
    (payload.top50||[]).forEach(r => {
      const isW = bollUpSet.has(r.代號), isM = mbollUpSet.has(r.代號);
      r.週布林站上上軌 = isW; r.月布林站上上軌 = isM;
      if (bollMap[r.代號]) r.布林上軌 = bollMap[r.代號].upper;
      if (mbollMap[r.代號]) r.月布林上軌 = mbollMap[r.代號].upper;
      let tags = splitI(r.狀態標註).filter(t => !['📈開週布林','📅開月布林','🌊波段熱門族群','🌙長線熱門族群','📈站上週布林'].includes(t));
      const myInds = splitI(r.相關產業);
      if (myInds.some(i=>top5Wave.has(i))) tags.push('🌊波段熱門族群');
      if (myInds.some(i=>top5Moon.has(i))) tags.push('🌙長線熱門族群');
      if (isW) tags.push('📈開週布林');
      if (isM) tags.push('📅開月布林');
      r.狀態標註 = tags.join(' / ');
    });

    // 寫回
    try { await putJSON(`${HIST_DIR}/${dk}.json`, payload, res.sha, `recompute ${dk}`); ok++; }
    catch (e) { fail++; console.warn(`  ${dk} 寫回失敗:${e.message}`); }

    if ((i+1) % 10 === 0 || i === allDates.length-1) {
      const w = (payload.waveInds[0]||{}).ind || '-';
      console.log(`  ${i+1}/${allDates.length} ${dk}：開週${bollUp.length}/開月${mbollUp.length}　波段Top:${w}`);
    }
  }
  console.log(`✅ 重算完成:成功 ${ok} 天,失敗 ${fail} 天`);
}

main().catch(e => { console.error('❌ 重算失敗:', e); process.exit(1); });
