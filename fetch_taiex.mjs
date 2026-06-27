#!/usr/bin/env node
// ───────────────────────────────────────────────────────────
// 抓取加權指數「最新月」漲跌幅,寫進 repo 的 config/taiex_monthly.json
// 在 GitHub Actions 伺服器端執行(無 CORS 限制)。
// 證交所 API: MI_5MINS_HIST 回傳當月每日加權指數開高低收。
// 用「當月最後一個交易日收盤」與「上月最後收盤」算月漲跌幅%。
// ───────────────────────────────────────────────────────────
import process from 'process';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO  = process.env.GITHUB_REPOSITORY;
const BRANCH = process.env.TARGET_BRANCH || 'main';
if (!TOKEN || !REPO) { console.error('缺少 GITHUB_TOKEN 或 GITHUB_REPOSITORY'); process.exit(1); }
const [OWNER, REPO_NAME] = REPO.split('/');
const API = `https://api.github.com/repos/${OWNER}/${REPO_NAME}`;

async function gh(url, opts = {}) {
  return fetch(url, { ...opts, headers: {
    'Authorization': `Bearer ${TOKEN}`, 'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json', ...(opts.headers||{}) } });
}
async function getJSON(repoPath) {
  const r = await gh(`${API}/contents/${repoPath}?ref=${BRANCH}`);
  if (!r.ok) { if (r.status === 404) return null; throw new Error(`GET ${repoPath} ${r.status}`); }
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content,'base64').toString('utf8')), sha: j.sha };
}
async function putJSON(repoPath, obj, sha, message) {
  const body = { message, content: Buffer.from(JSON.stringify(obj,null,2)).toString('base64'), branch: BRANCH };
  if (sha) body.sha = sha;
  const r = await gh(`${API}/contents/${repoPath}`, { method:'PUT', body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`PUT ${repoPath} ${r.status}: ${await r.text()}`);
  return r.json();
}

// 抓證交所某月加權指數每日收盤,回傳該月最後收盤
async function fetchMonthLastClose(yyyymm) {
  const url = `https://www.twse.com.tw/indicesReport/MI_5MINS_HIST?response=json&date=${yyyymm}01`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`TWSE ${yyyymm} ${r.status}`);
  const j = await r.json();
  // data 每列:[日期, 開, 高, 低, 收]
  const rows = j.data || [];
  if (!rows.length) return null;
  const last = rows[rows.length-1];
  const close = parseFloat(String(last[4]).replace(/,/g,''));
  return Number.isFinite(close) ? close : null;
}

function ym(y, m) { return `${y}${String(m).padStart(2,'0')}`; }
function ymLabel(y, m) { return `${y}/${String(m).padStart(2,'0')}`; }

async function main() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth()+1;
  // 抓「本月」與「上月」最後收盤,算本月漲跌幅
  const py = m === 1 ? y-1 : y, pm = m === 1 ? 12 : m-1;

  console.log(`▶ 抓取加權指數 ${ymLabel(y,m)} 與上月 ${ymLabel(py,pm)}`);
  let curClose = null, prevClose = null;
  try { curClose = await fetchMonthLastClose(ym(y,m)); } catch(e){ console.warn('本月抓取失敗:', e.message); }
  try { prevClose = await fetchMonthLastClose(ym(py,pm)); } catch(e){ console.warn('上月抓取失敗:', e.message); }

  if (curClose == null || prevClose == null) { console.error('收盤資料不足,無法計算'); process.exit(1); }
  const pct = +(((curClose - prevClose) / prevClose) * 100).toFixed(2);
  console.log(`  ${ymLabel(y,m)} 收盤 ${curClose} / 上月 ${prevClose} → 漲跌 ${pct}%`);

  // 讀現有 config/taiex_monthly.json,合併本月
  let store = {}, sha = null;
  try { const cur = await getJSON('config/taiex_monthly.json'); if (cur) { store = cur.data.monthly || cur.data || {}; sha = cur.sha; } } catch(_){}
  store[ymLabel(y,m)] = pct;
  await putJSON('config/taiex_monthly.json', { monthly: store, updatedAt: Date.now() }, sha, `taiex ${ymLabel(y,m)} ${pct}%`);
  console.log(`✅ 已寫入 config/taiex_monthly.json (${Object.keys(store).length} 個月)`);
}

main().catch(e => { console.error('❌ 失敗:', e); process.exit(1); });
