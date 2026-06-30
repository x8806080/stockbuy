#!/usr/bin/env node
// ───────────────────────────────────────────────────────────
// 把 data/raw/final_output_YYYYMMDD.csv 轉成 data/daily/YYYYMMDD.json(網頁回測用 payload)
// 在 GitHub Actions 伺服器端執行,全自動。
//
// 評分:因 final_output 無市值/產業,沿用網頁「缺市值用絕對金額保底」邏輯;
//       相關產業用 index.html 的 STOCK_DICT 補。
// 布林:用累積收盤序列算週/月布林(與 recompute.mjs 一致)。
//
// 環境變數: GITHUB_TOKEN, GITHUB_REPOSITORY (Actions提供), START/END (YYYYMMDD), TARGET_BRANCH
// ───────────────────────────────────────────────────────────
import fs from 'fs';
import process from 'process';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO  = process.env.GITHUB_REPOSITORY;
const BRANCH = process.env.TARGET_BRANCH || 'main';
const START = process.env.START || '';   // YYYYMMDD(空=全部 data/raw)
const END   = process.env.END   || '';
if (!TOKEN || !REPO) { console.error('缺少 GITHUB_TOKEN/GITHUB_REPOSITORY'); process.exit(1); }
const [OWNER, REPO_NAME] = REPO.split('/');
const API = `https://api.github.com/repos/${OWNER}/${REPO_NAME}`;

// 評分預設(同網頁 DEFAULTS)
const SC = {
  // 法人5日:有市值用比值分位,score A/B/C
  s5A:60, s5B:40, s5C:30, f5A:6000, f5B:1000, f5C:500,
  // 法人月:score A/B/C
  s1A:40, s1B:20, s1C:10, f1A:20000, f1B:5000, f1C:2000,
  // 動能
  mBoth:20, m5d:10, m1m:10, mDay:10, topPct:10, dayPct:10,
  comboP90:15, comboP70:8,
};

async function gh(url, opts={}) {
  return fetch(url, { ...opts, headers: {
    'Authorization': `Bearer ${TOKEN}`, 'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json', ...(opts.headers||{}) } });
}
async function getJSON(repoPath) {
  const r = await gh(`${API}/contents/${repoPath}?ref=${BRANCH}`);
  if (!r.ok) { if (r.status===404) return null; throw new Error(`GET ${repoPath} ${r.status}`); }
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content,'base64').toString('utf8')), sha: j.sha };
}
async function getRaw(repoPath) {  // 取原始文字(CSV)
  const r = await gh(`${API}/contents/${repoPath}?ref=${BRANCH}`);
  if (!r.ok) { if (r.status===404) return null; throw new Error(`GET ${repoPath} ${r.status}`); }
  const j = await r.json();
  return { text: Buffer.from(j.content,'base64').toString('utf8'), sha: j.sha };
}
async function putJSON(repoPath, obj, sha, message) {
  const body = { message, content: Buffer.from(JSON.stringify(obj)).toString('base64'), branch: BRANCH };
  if (sha) body.sha = sha;
  for (let a=0; a<6; a++) {
    const r = await gh(`${API}/contents/${repoPath}`, { method:'PUT', body: JSON.stringify(body) });
    if (r.ok) return true;
    if (r.status===409||r.status===422) { const cur=await getJSON(repoPath).catch(()=>null); if(cur)body.sha=cur.sha; await new Promise(s=>setTimeout(s,400*(a+1))); continue; }
    throw new Error(`PUT ${repoPath} ${r.status}`);
  }
  return false;
}
async function listRawFiles() {
  const out = [];
  try {
    const ref = await gh(`${API}/git/refs/heads/${BRANCH}`);
    const sha = (await ref.json()).object.sha;
    const tree = await gh(`${API}/git/trees/${sha}?recursive=1`);
    const tj = await tree.json();
    (tj.tree||[]).forEach(n => { const m=n.path.match(/^data\/raw\/final_output_(\d{8})\.csv$/); if(m) out.push(m[1]); });
  } catch(e) { console.warn('列檔失敗:', e.message); }
  return out.sort();
}

function loadStockDict() {
  const html = fs.readFileSync('index.html','utf8');
  const m = html.match(/const STOCK_DICT = (\{.*?\});/s);
  return m ? JSON.parse(m[1]) : {};
}

// CSV 解析(處理引號、逗號)
function parseCSV(text) {
  const lines = text.replace(/\r/g,'').replace(/^\uFEFF/,'').split('\n').filter(l=>l.trim());
  if (!lines.length) return [];
  const headers = lines[0].replace(/^\uFEFF/,'').split(',').map(h=>h.trim());
  return lines.slice(1).map(line => {
    const cells = []; let cur=''; let q=false;
    for (const ch of line) {
      if (ch === '"') q=!q;
      else if (ch === ',' && !q) { cells.push(cur); cur=''; }
      else cur += ch;
    }
    cells.push(cur);
    const o = {}; headers.forEach((h,i)=>o[h]=(cells[i]||'').trim()); return o;
  });
}
const num = v => { const n = parseFloat(String(v).replace(/[,%+↗↘\s]/g,'')); return Number.isFinite(n)?n:null; };

// 布林(與 recompute.mjs 一致)
function weekKeyOf(dk){ const y=+dk.slice(0,4),mo=+dk.slice(4,6),d=+dk.slice(6,8); const dt=new Date(y,mo-1,d); const dy=dt.getDay()||7; dt.setDate(dt.getDate()-dy+1); return dt.getFullYear()+String(dt.getMonth()+1).padStart(2,'0')+String(dt.getDate()).padStart(2,'0'); }
function monthKeyOf(dk){ return dk.slice(0,6); }
function computeWeeklyBollinger(hist,period=20,k=2){ const out={}; for(const s in hist){const a=hist[s]; if(!a||a.length<period*3)continue; const wm={}; a.forEach(({dk,close})=>{if(close>0)wm[weekKeyOf(dk)]=close;}); const wc=Object.keys(wm).sort().map(w=>wm[w]); if(wc.length<period)continue; const r=wc.slice(-period); const sma=r.reduce((x,y)=>x+y,0)/period; const std=Math.sqrt(r.reduce((x,y)=>x+(y-sma)**2,0)/period); const up=sma+k*std; const wclose=wc[wc.length-1]; out[s]={upper:up,aboveUpper:wclose>up};} return out; }
function computeMonthlyBollinger(hist,period=20,k=2){ const out={}; for(const s in hist){const a=hist[s]; if(!a||a.length<period*15)continue; const mm={}; a.forEach(({dk,close})=>{if(close>0)mm[monthKeyOf(dk)]=close;}); const mc=Object.keys(mm).sort().map(m=>mm[m]); if(mc.length<period)continue; const r=mc.slice(-period); const sma=r.reduce((x,y)=>x+y,0)/period; const std=Math.sqrt(r.reduce((x,y)=>x+(y-sma)**2,0)/period); const up=sma+k*std; const mclose=mc[mc.length-1]; out[s]={upper:up,aboveUpper:mclose>up};} return out; }

const splitI = s => (s||'').split(/[,、，;；/]/).map(x=>x.trim()).filter(Boolean);

// 把一天的 CSV rows 算成 payload
function buildPayload(rows, dateKey, bollMap, mbollMap, DICT, baseClose) {
  // 解析欄位 + 補產業/市值(字典),並算當日市值
  const data = rows.map(r => {
    const code = (r['代號']||'').trim();
    const dict = DICT[code] || {};
    const ind = dict.i || '';
    const dictMcap億 = dict.m || 0;        // 字典市值(對應基準日股價)
    const close = num(r['當日收盤價']) || 0;
    const base = (baseClose && baseClose[code]) || 0;   // 基準日收盤
    // 當日市值 = 字典市值 × (當日收盤 ÷ 基準收盤);股數假設不變
    let mcap億 = dictMcap億;
    if (dictMcap億 > 0 && base > 0 && close > 0) {
      mcap億 = dictMcap億 * (close / base);
    }
    return {
      代號: code, 名稱: r['名稱']||'',
      收盤價: close,
      當日漲幅: num(r['當日漲幅(%)']),
      漲幅5日: num(r['5日漲幅(%)']),
      漲幅1月: num(r['1個月漲幅(%)']),
      金額當日萬: num(r['當日買賣超金額(萬元)']) || 0,
      金額5日萬: num(r['5日買賣超金額(萬元)']) || 0,
      金額1月萬: num(r['1個月買賣超金額(萬元)']) || 0,
      相關產業: ind, 市值億: mcap億,
    };
  }).filter(r => r.代號 && /^\d{4}$/.test(r.代號));

  // 比值(買超百萬 ÷ 市值百萬;市值億×100=百萬)
  data.forEach(r => {
    const mcapM = r.市值億 * 100;
    r._corp5 = r.金額5日萬/100; r._corp1m = r.金額1月萬/100;
    r._ratio5  = mcapM > 0 ? r._corp5/mcapM : 0;
    r._ratio1m = mcapM > 0 ? r._corp1m/mcapM : 0;
  });

  // 動能:前N%門檻
  const topByPct = (field, p) => {
    const arr = data.map(r=>r[field]).filter(v=>v!=null && v>0).sort((a,b)=>b-a);
    if (!arr.length) return new Set();
    const th = arr[Math.min(arr.length-1, Math.floor(arr.length*p/100))];
    return new Set(data.filter(r=>r[field]!=null && r[field]>=th).map(r=>r.代號));
  };
  const rise5dTop = topByPct('漲幅5日', SC.topPct);
  const rise1mTop = topByPct('漲幅1月', SC.topPct);
  const riseDayTop = topByPct('當日漲幅', SC.dayPct);

  // 自動分位門檻:用 5日/1月漲幅前N%(進榜標的)的比值算 P90/P70/P50(同網頁)
  const benchRows = data.filter(r => rise5dTop.has(r.代號) || rise1mTop.has(r.代號));
  const pctOf = (field, p) => {
    const arr = benchRows.map(r=>r[field]).filter(v=>v>0).sort((a,b)=>a-b);
    if (!arr.length) return 0;
    return arr[Math.max(0, Math.floor(arr.length*p/100)-1)];
  };
  const auto5A=pctOf('_ratio5',90), auto5B=pctOf('_ratio5',70), auto5C=pctOf('_ratio5',50);
  const auto1A=pctOf('_ratio1m',90), auto1B=pctOf('_ratio1m',70), auto1C=pctOf('_ratio1m',50);

  // 評分:有市值用比值分位,無市值用絕對金額保底(同網頁)
  data.forEach(r => {
    let score = 0; const tags = [];
    const hasMcap = r.市值億 > 0;
    // 法人5日
    if (hasMcap && r._ratio5 > 0) {
      if      (auto5A>0 && r._ratio5>=auto5A) { score+=SC.s5A; tags.push('🏆P90'); }
      else if (auto5B>0 && r._ratio5>=auto5B) { score+=SC.s5B; tags.push('P70'); }
      else if (auto5C>0 && r._ratio5>=auto5C) { score+=SC.s5C; tags.push('P50'); }
    } else if (r._corp5 > 0) {
      if      (r._corp5 > SC.f5A/100)  { score+=SC.s5A; tags.push('🏆P90'); }
      else if (r._corp5 >= SC.f5B/100) { score+=SC.s5B; tags.push('P70'); }
      else if (r._corp5 >= SC.f5C/100) { score+=SC.s5C; tags.push('P50'); }
    }
    // 法人月 P90/P70/P50(+月比值標籤,記 monthLevel 供組合獎勵)
    let monthLevel = '';
    if (hasMcap && r._ratio1m > 0) {
      if      (auto1A>0 && r._ratio1m>=auto1A) { score+=SC.s1A; tags.push('🏛️月P90'); monthLevel='P90'; }
      else if (auto1B>0 && r._ratio1m>=auto1B) { score+=SC.s1B; tags.push('月比P70'); monthLevel='P70'; }
      else if (auto1C>0 && r._ratio1m>=auto1C) { score+=SC.s1C; tags.push('月比P50'); monthLevel='P50'; }
    } else if (r._corp1m > 0) {
      if      (r._corp1m > SC.f1A/100)  { score+=SC.s1A; tags.push('🏛️月P90'); monthLevel='P90'; }
      else if (r._corp1m >= SC.f1B/100) { score+=SC.s1B; tags.push('月比P70'); monthLevel='P70'; }
      else if (r._corp1m >= SC.f1C/100) { score+=SC.s1C; tags.push('月比P50'); monthLevel='P50'; }
    }
    // 動能(雙動能共振/5日/一月/當日強勢)
    const r5In = rise5dTop.has(r.代號), r1mIn = rise1mTop.has(r.代號), rDayIn = riseDayTop.has(r.代號);
    if (r5In && r1mIn) { score+=SC.mBoth; tags.push('雙動能共振'); }
    else if (r5In)     { score+=SC.m5d; tags.push('5日動能'); }
    else if (r1mIn)    { score+=SC.m1m; tags.push('一月動能'); }
    if (rDayIn)        { score+=SC.mDay; tags.push('當日強勢'); }
    // 組合獎勵(當日強勢 + 月P90/P70)
    if (rDayIn && monthLevel==='P90') { score+=SC.comboP90; tags.push('⭐當日+月P90'); }
    else if (rDayIn && monthLevel==='P70') { score+=SC.comboP70; tags.push('⭐當日+月P70'); }
    // 布林標籤
    const b = bollMap[r.代號], mb = mbollMap[r.代號];
    if (b && b.aboveUpper) tags.push('📈開週布林');
    if (mb && mb.aboveUpper) tags.push('📅開月布林');
    r.綜合評分 = score; r._tags = tags;
    r.三大法人5日買超 = r.金額5日萬;
    // 市值比顯示值(同網頁:比值×100,3位小數;無市值顯示-)
    r.法人市值比pct = (r.市值億 > 0 && r._ratio5 > 0) ? (r._ratio5*100).toFixed(3) + '%' : '-';
    r.法人月市值比pct = (r.市值億 > 0 && r._ratio1m > 0) ? (r._ratio1m*100).toFixed(3) + '%' : '-';
    r.投信市值比pct = '-';   // final_output 無投信單獨資料,留白
  });

  // 族群統計:5日漲幅前N%
  const tally = (filterFn) => {
    const m = {};
    data.forEach(r => { if(!filterFn(r)||!r.相關產業)return; splitI(r.相關產業).forEach(i=>{ if(!m[i])m[i]={ind:i,count:0,corp:0}; m[i].count++; m[i].corp+=r.金額5日萬/100; }); });
    return Object.entries(m).sort((a,b)=>(b[1].count-a[1].count)||(b[1].corp-a[1].corp)).slice(0,8).map(([k,v])=>({ind:k,count:v.count,corp:v.corp}));
  };
  const hotInds  = tally(r => rise5dTop.has(r.代號));
  const waveInds = tally(r => bollMap[r.代號] && bollMap[r.代號].aboveUpper);
  const moonInds = tally(r => mbollMap[r.代號] && mbollMap[r.代號].aboveUpper);
  const top5Hot = new Set(hotInds.slice(0,5).map(d=>d.ind));
  const top5Wave = new Set(waveInds.slice(0,5).map(d=>d.ind));
  const top5Moon = new Set(moonInds.slice(0,5).map(d=>d.ind));

  // 全市場開週/開月布林清單
  const bollUp = data.filter(r => bollMap[r.代號] && bollMap[r.代號].aboveUpper).map(r=>r.代號);
  const mbollUp = data.filter(r => mbollMap[r.代號] && mbollMap[r.代號].aboveUpper).map(r=>r.代號);

  // 加族群標籤,組 top50
  data.forEach(r => {
    const myInds = splitI(r.相關產業);
    if (myInds.some(i=>top5Hot.has(i))) r._tags.push('🔥熱門族群');
    if (myInds.some(i=>top5Wave.has(i))) r._tags.push('🌊波段熱門族群');
    if (myInds.some(i=>top5Moon.has(i))) r._tags.push('🌙長線熱門族群');
    r.狀態標註 = r._tags.join(' / ');
    const b = bollMap[r.代號], mb = mbollMap[r.代號];
    r.布林上軌 = b ? b.upper : null;
    r.月布林上軌 = mb ? mb.upper : null;
    r.週布林站上上軌 = !!(b && b.aboveUpper);
    r.月布林站上上軌 = !!(mb && mb.aboveUpper);
  });

  const top50 = data.slice().sort((a,b)=>(b.綜合評分-a.綜合評分)||(b.金額5日萬-a.金額5日萬)).slice(0,50)
    .map(r => ({ 代號:r.代號, 名稱:r.名稱, 綜合評分:r.綜合評分, 收盤價:r.收盤價,
      當日漲幅:r.當日漲幅, 漲幅5日:r.漲幅5日, 漲幅1月:r.漲幅1月,
      相關產業:r.相關產業, 三大法人5日買超:r.金額5日萬, 狀態標註:r.狀態標註,
      法人市值比pct:r.法人市值比pct, 法人月市值比pct:r.法人月市值比pct, 投信市值比pct:r.投信市值比pct,
      市值:r.市值億*100,
      布林上軌:r.布林上軌, 月布林上軌:r.月布林上軌, 週布林站上上軌:r.週布林站上上軌, 月布林站上上軌:r.月布林站上上軌 }));

  const priceMap = {}; data.forEach(r => { if(r.收盤價>0) priceMap[r.代號]=r.收盤價; });

  return { dateKey, top50, priceMap, bollUp, mbollUp, hotInds, waveInds, moonInds,
           generatedBy:'convert_raw.mjs', at:Date.now() };
}

async function main() {
  console.log(`▶ 轉換 data/raw CSV → data/daily JSON  (${START||'全部'}~${END||'全部'})`);
  const DICT = loadStockDict();
  console.log(`  字典 ${Object.keys(DICT).length} 檔`);

  let dates = await listRawFiles();
  if (START) dates = dates.filter(d => d >= START);
  if (END)   dates = dates.filter(d => d <= END);
  if (!dates.length) { console.error('data/raw 無符合的 CSV'); process.exit(1); }
  console.log(`  待轉換 ${dates.length} 天`);

  // 預掃:取每檔在「整個 data/raw 範圍最後一天」的收盤,當作字典市值對應的基準股價
  // 股數 = 字典市值 ÷ 基準收盤;當日市值 = 股數 × 當日收盤(近似,假設股數不變)
  console.log('  預掃基準收盤(算當日市值用)…');
  const baseClose = {};   // { 代號: 最後一天收盤 }
  const allRaw = await listRawFiles();
  const lastDate = allRaw[allRaw.length-1];
  if (lastDate) {
    try {
      const lr = await getRaw(`data/raw/final_output_${lastDate}.csv`);
      if (lr) parseCSV(lr.text).forEach(r => { const c=(r['代號']||'').trim(); const v=num(r['當日收盤價']); if(/^\d{4}$/.test(c)&&v>0) baseClose[c]=v; });
    } catch(_){}
  }
  console.log(`  基準收盤 ${Object.keys(baseClose).length} 檔(基準日 ${lastDate})`);

  const bollHist = {};

  // ── 預載「轉換起始日之前」的舊 JSON 收盤,補足布林所需歷史(避免只轉一個月布林算不出來)──
  // 布林需約 460 個交易日;從舊 data/daily 撈起始日前的 priceMap 收盤填入 bollHist
  try {
    const firstDk = dates[0];
    const idxRes = await getJSON('data/daily/index.json').catch(()=>null);
    const allDailyDates = (idxRes?.data || []).filter(d => d < firstDk).sort();
    // 只取最近 ~460 天(布林上限),避免讀太多
    const preloadDates = allDailyDates.slice(-460);
    if (preloadDates.length) {
      console.log(`  預載舊 JSON 收盤補布林歷史:${preloadDates.length} 天(${preloadDates[0]}~${preloadDates[preloadDates.length-1]})`);
      let loaded = 0;
      for (const pdk of preloadDates) {
        try {
          const old = await getJSON(`data/daily/${pdk}.json`);
          const pm = old?.data?.priceMap || {};
          for (const sym in pm) {
            const c = pm[sym];
            if (c > 0) { if (!bollHist[sym]) bollHist[sym]=[]; bollHist[sym].push({ dk:pdk, close:c }); }
          }
          loaded++;
        } catch(_){}
      }
      // 各檔截到最近 460 筆
      for (const s in bollHist) if (bollHist[s].length > 460) bollHist[s] = bollHist[s].slice(-460);
      console.log(`  ✓ 預載完成:${loaded} 天,涵蓋 ${Object.keys(bollHist).length} 檔`);
    } else {
      console.log('  (無更早的舊 JSON 可預載,布林將從本次資料累積)');
    }
  } catch(e) { console.warn('  預載舊收盤失敗(不影響轉換):', e.message); }

  let ok=0, fail=0;
  const t0 = Date.now();
  for (let i=0;i<dates.length;i++) {
    const dk = dates[i];
    if (Date.now()-t0 > 5*3600*1000) { console.log('⏱ 接近5小時,提前停止'); break; }
    let raw;
    try { raw = await getRaw(`data/raw/final_output_${dk}.csv`); } catch(e){ fail++; continue; }
    if (!raw) { fail++; continue; }
    const rows = parseCSV(raw.text);
    // 累積收盤(算布林)
    rows.forEach(r => { const code=(r['代號']||'').trim(); const c=num(r['當日收盤價']); if(/^\d{4}$/.test(code)&&c>0){ if(!bollHist[code])bollHist[code]=[]; bollHist[code].push({dk,close:c}); if(bollHist[code].length>460)bollHist[code]=bollHist[code].slice(-460);} });
    const bollMap = computeWeeklyBollinger(bollHist,20,2);
    const mbollMap = computeMonthlyBollinger(bollHist,20,2);
    const payload = buildPayload(rows, dk, bollMap, mbollMap, DICT, baseClose);
    // 寫 data/daily/YYYYMMDD.json
    try {
      let sha=null; try{ const cur=await getJSON(`data/daily/${dk}.json`); sha=cur?.sha||null; }catch(_){}
      await putJSON(`data/daily/${dk}.json`, payload, sha, `convert ${dk}`);
      ok++;
    } catch(e){ fail++; console.warn(`  ${dk} 寫入失敗: ${e.message}`); }
    if ((i+1)%10===0 || i===dates.length-1) console.log(`  ${i+1}/${dates.length} ${dk}: top50=${payload.top50.length} 開週布林=${payload.bollUp.length}`);
  }

  // 更新 data/daily/index.json(把新日期併入)
  try {
    let idx=[], sha=null;
    try { const cur=await getJSON('data/daily/index.json'); if(cur){ idx=cur.data||[]; sha=cur.sha; } } catch(_){}
    const set = new Set(idx); dates.slice(0,ok).forEach(d=>set.add(d));
    const merged = [...set].sort();
    await putJSON('data/daily/index.json', merged, sha, `index +${ok}`);
    console.log(`  index.json 更新,共 ${merged.length} 天`);
  } catch(e){ console.warn('index 更新失敗:', e.message); }

  console.log(`✅ 完成:成功 ${ok} 天,失敗 ${fail} 天`);
}
main().catch(e=>{ console.error('❌ 失敗:', e); process.exit(1); });
