#!/usr/bin/env node
// ───────────────────────────────────────────────────────────
// 盤點 repo data/daily/ 在指定年月範圍缺哪些交易日(零風險,只讀不抓)
// 環境變數:
//   GITHUB_TOKEN, GITHUB_REPOSITORY (Actions 自動提供)
//   START (YYYYMM 起,預設 201601)  END (YYYYMM 迄,預設 202212)
// ───────────────────────────────────────────────────────────
import process from 'process';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO  = process.env.GITHUB_REPOSITORY;
const BRANCH = process.env.TARGET_BRANCH || 'main';
const START = process.env.START || '201601';   // YYYYMM
const END   = process.env.END   || '202212';   // YYYYMM
if (!TOKEN || !REPO) { console.error('缺少 GITHUB_TOKEN/GITHUB_REPOSITORY'); process.exit(1); }
const [OWNER, REPO_NAME] = REPO.split('/');
const API = `https://api.github.com/repos/${OWNER}/${REPO_NAME}`;

async function gh(url, opts={}) {
  return fetch(url, { ...opts, headers: {
    'Authorization': `Bearer ${TOKEN}`, 'Accept': 'application/vnd.github+json', ...(opts.headers||{}) } });
}

// 列出 data/daily 下所有檔(可能超過 1000,需分頁)
async function listDailyFiles() {
  const have = new Set();
  // 先試 git tree(一次抓全部,較快)
  try {
    const ref = await gh(`${API}/git/refs/heads/${BRANCH}`);
    if (ref.ok) {
      const refJson = await ref.json();
      const sha = refJson.object.sha;
      const tree = await gh(`${API}/git/trees/${sha}?recursive=1`);
      if (tree.ok) {
        const tj = await tree.json();
        (tj.tree||[]).forEach(node => {
          const m = node.path.match(/^data\/daily\/(\d{8})\.json$/);
          if (m) have.add(m[1]);
        });
        return have;
      }
    }
  } catch(e) { console.warn('git tree 失敗,改用 contents API:', e.message); }
  // 備案:contents API
  const r = await gh(`${API}/contents/data/daily?ref=${BRANCH}`);
  if (r.ok) {
    const arr = await r.json();
    arr.forEach(f => { const m = (f.name||'').match(/^(\d{8})\.json$/); if (m) have.add(m[1]); });
  }
  return have;
}

// 產生某年月範圍的「工作日」(週一~五,不含國定假日,僅粗略)
function workdaysInRange(startYM, endYM) {
  const sY = +startYM.slice(0,4), sM = +startYM.slice(4,6);
  const eY = +endYM.slice(0,4), eM = +endYM.slice(4,6);
  const days = [];
  let d = new Date(sY, sM-1, 1);
  const end = new Date(eY, eM-1, 1); end.setMonth(end.getMonth()+1); // 迄月底
  while (d < end) {
    const dow = d.getDay();
    if (dow >= 1 && dow <= 5) {
      days.push(`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`);
    }
    d.setDate(d.getDate()+1);
  }
  return days;
}

async function main() {
  console.log(`▶ 盤點 ${START} ~ ${END} 的 data/daily 缺口`);
  const have = await listDailyFiles();
  console.log(`  repo 現有 daily 檔: ${have.size} 個`);

  const workdays = workdaysInRange(START, END);
  const missing = workdays.filter(dk => !have.has(dk));

  // 依年月統計缺口
  const byMonth = {};
  missing.forEach(dk => { const ym = dk.slice(0,6); byMonth[ym] = (byMonth[ym]||0)+1; });

  console.log(`  工作日總數(粗估,未扣國定假日): ${workdays.length}`);
  console.log(`  缺漏天數: ${missing.length}`);
  console.log(`\n  各月缺口:`);
  Object.keys(byMonth).sort().forEach(ym => {
    console.log(`    ${ym.slice(0,4)}/${ym.slice(4,6)}: 缺 ${byMonth[ym]} 天`);
  });

  // 寫一份盤點結果到 repo(供網頁或下次抓取參考)
  try {
    const body = {
      message: `check_missing ${START}-${END}`,
      content: Buffer.from(JSON.stringify({
        range: { start: START, end: END },
        haveCount: have.size,
        missingCount: missing.length,
        missing,                 // 缺漏日期清單(YYYYMMDD)
        byMonth,
        checkedAt: Date.now(),
      }, null, 2)).toString('base64'),
      branch: BRANCH,
    };
    let sha = null;
    const cur = await gh(`${API}/contents/config/missing_report.json?ref=${BRANCH}`);
    if (cur.ok) { sha = (await cur.json()).sha; }
    if (sha) body.sha = sha;
    const put = await gh(`${API}/contents/config/missing_report.json`, { method:'PUT', body: JSON.stringify(body) });
    if (put.ok) console.log(`\n✅ 缺口清單已寫入 config/missing_report.json`);
    else console.warn(`寫入失敗: ${put.status}`);
  } catch(e) { console.warn('寫入盤點結果失敗:', e.message); }
}

main().catch(e => { console.error('❌ 失敗:', e); process.exit(1); });
