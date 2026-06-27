#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ───────────────────────────────────────────────────────────
# 歷史 final_output 批次抓取(GitHub Actions 無頭版)
# 引擎邏輯原封不動沿用 app.py(保留所有防封鎖戰術),只拔掉 Streamlit 介面,
# 改成:讀環境變數的日期區間 → 抓籌碼+股價 → 算 final_output → 寫回 repo data/raw/
#
# 環境變數(Actions workflow 提供):
#   GITHUB_TOKEN, GITHUB_REPOSITORY  (Actions 自動提供)
#   START (YYYYMMDD 起), END (YYYYMMDD 迄)
#   TARGET_BRANCH (預設 main)
# ───────────────────────────────────────────────────────────
import os, sys, time, random, json, base64, datetime
from datetime import date, timedelta
import requests
import pandas as pd
import numpy as np

TOKEN  = os.environ.get("GITHUB_TOKEN")
REPO   = os.environ.get("GITHUB_REPOSITORY")    # e.g. x8806080/stockbuy
BRANCH = os.environ.get("TARGET_BRANCH", "main")
START  = os.environ.get("START")                # YYYYMMDD
END    = os.environ.get("END")                  # YYYYMMDD

if not (TOKEN and REPO and START and END):
    print("缺少 GITHUB_TOKEN / GITHUB_REPOSITORY / START / END"); sys.exit(1)

OWNER, REPO_NAME = REPO.split("/")
API = f"https://api.github.com/repos/{OWNER}/{REPO_NAME}"
GH_HEADERS = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json"}

# 本地暫存(Actions runner 上,跑完即丟;籌碼快取避免重複抓)
DATA_DIR = "data_tmp"
os.makedirs(DATA_DIR, exist_ok=True)

# ── 延後 import yfinance(裝好才 import,避免啟動就失敗)──
import yfinance as yf

# ═══════════════ 引擎(沿用 app.py)═══════════════
def is_valid_stock(code):
    code = str(code).strip()
    return len(code) == 4 and code.isdigit()

def get_daily_chips(target_date):
    """抓 T86 籌碼並剔除權證(沿用 app.py)"""
    date_str = target_date.strftime("%Y%m%d")
    file_path = os.path.join(DATA_DIR, f"chips_{date_str}.csv")
    if os.path.exists(file_path):
        return pd.read_csv(file_path, dtype={'代號': str})
    url = f"https://www.twse.com.tw/fund/T86?response=json&date={date_str}&selectType=ALL"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    try:
        res = requests.get(url, headers=headers, timeout=10)
        data = res.json()
        if data.get('stat') == 'OK':
            df = pd.DataFrame(data['data'], columns=data['fields'])
            df.columns = [str(c).replace(' ', '').strip() for c in df.columns]
            df = df.rename(columns={'證券代號': '代號', '證券名稱': '名稱'})
            df = df[df['代號'].apply(is_valid_stock)].copy()
            shares = pd.to_numeric(df['三大法人買賣超股數'].astype(str).str.replace(',', ''), errors='coerce').fillna(0)
            df['三大法人買超'] = shares / 1000
            final_df = df[['代號', '名稱', '三大法人買超']]
            final_df.to_csv(file_path, index=False, encoding='utf-8-sig')
            time.sleep(random.uniform(1.0, 2.0))
            return final_df
        return None
    except Exception:
        return None

def get_price_history(target_date, stock_list):
    """撒網捕魚抓 Yahoo 股價(沿用 app.py 防封鎖戰術)"""
    tickers = [f"{code}.TW" for code in stock_list]
    start_date = (pd.to_datetime(target_date) - datetime.timedelta(days=45)).strftime("%Y-%m-%d")
    end_date = (pd.to_datetime(target_date) + datetime.timedelta(days=2)).strftime("%Y-%m-%d")
    session = requests.Session()
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*', 'Connection': 'keep-alive'
    })
    all_close = pd.DataFrame()
    chunk_size = 40
    for i in range(0, len(tickers), chunk_size):
        chunk = tickers[i:i+chunk_size]
        try:
            df = yf.download(chunk, start=start_date, end=end_date, progress=False,
                             session=session, threads=False, timeout=12)
            if df.empty or 'Close' not in df.columns:
                time.sleep(1); continue
            close_df = df['Close']
            if isinstance(close_df, pd.Series):
                close_df = close_df.to_frame(chunk[0])
            close_df.index = pd.to_datetime(close_df.index).tz_localize(None)
            all_close = pd.concat([all_close, close_df], axis=1)
            time.sleep(random.uniform(1.0, 2.5))
        except Exception:
            time.sleep(2); continue
    if not all_close.empty:
        all_close = all_close[all_close.index.date <= target_date]
    return all_close

def run_engine(target_date):
    """單日運算(沿用 app.py run_time_machine_engine,拔掉 st 介面)"""
    date_str = target_date.strftime("%Y%m%d")
    final_cache_path = os.path.join(DATA_DIR, f"final_output_{date_str}.csv")
    if os.path.exists(final_cache_path):
        df_cache = pd.read_csv(final_cache_path, dtype={'代號': str})
        if '當日漲幅(%)' in df_cache.columns:
            return df_cache

    valid_dates_data = []
    curr = target_date; count = 0
    while len(valid_dates_data) < 20 and count < 60:
        if curr.weekday() < 5:
            d = get_daily_chips(curr)
            if d is not None and not d.empty:
                d['Date'] = curr
                valid_dates_data.append(d)
        curr -= datetime.timedelta(days=1); count += 1

    if not valid_dates_data:
        print(f"  ❌ {target_date} 查無籌碼資料(可能非交易日)"); return pd.DataFrame()

    df_1d = valid_dates_data[0][['代號', '名稱', '三大法人買超']].copy()
    df_1d.rename(columns={'三大法人買超': '當日買超(張)'}, inplace=True)
    df_5d = pd.concat(valid_dates_data[:5]).groupby(['代號', '名稱'])['三大法人買超'].sum().reset_index()
    df_5d.rename(columns={'三大法人買超': '5日買超(張)'}, inplace=True)
    df_20d = pd.concat(valid_dates_data[:20]).groupby(['代號', '名稱'])['三大法人買超'].sum().reset_index()
    df_20d.rename(columns={'三大法人買超': '1個月買超(張)'}, inplace=True)
    final = df_20d.merge(df_5d[['代號', '5日買超(張)']], on='代號', how='left')
    final = final.merge(df_1d[['代號', '當日買超(張)']], on='代號', how='left')
    final.fillna(0, inplace=True)

    latest_d = valid_dates_data[0]['Date'].iloc[0]
    all_prices = get_price_history(latest_d, final['代號'].tolist())

    latest_prices = all_prices.iloc[-1] if len(all_prices) >= 1 else pd.Series()
    p_1_prices = all_prices.iloc[-2] if len(all_prices) >= 2 else pd.Series()
    p_5_prices = all_prices.iloc[-6] if len(all_prices) >= 6 else pd.Series()
    p_20_prices = all_prices.iloc[-21] if len(all_prices) >= 21 else (all_prices.iloc[0] if not all_prices.empty else pd.Series())

    def get_p(code, p_series):
        ticker = f"{code}.TW"
        return p_series[ticker] if ticker in p_series else np.nan

    final['當日收盤價'] = final['代號'].apply(lambda x: get_p(x, latest_prices))
    final['P1'] = final['代號'].apply(lambda x: get_p(x, p_1_prices))
    final['P5'] = final['代號'].apply(lambda x: get_p(x, p_5_prices))
    final['P20'] = final['代號'].apply(lambda x: get_p(x, p_20_prices))
    for c in ['當日收盤價','P1','P5','P20']:
        final[c] = pd.to_numeric(final[c], errors='coerce')
    final['當日收盤價'] = final['當日收盤價'].fillna(0)

    final['當日買賣超金額(萬元)'] = round(final['當日買超(張)'] * final['當日收盤價'] * 0.1, 2)
    final['5日買賣超金額(萬元)'] = round(final['5日買超(張)'] * final['當日收盤價'] * 0.1, 2)
    final['1個月買賣超金額(萬元)'] = round(final['1個月買超(張)'] * final['當日收盤價'] * 0.1, 2)
    final['當日漲幅(%)'] = np.where(final['P1'] > 0, round((final['當日收盤價'] - final['P1']) / final['P1'] * 100, 2), 0)
    final['5日漲幅(%)'] = np.where(final['P5'] > 0, round((final['當日收盤價'] - final['P5']) / final['P5'] * 100, 2), 0)
    final['1個月漲幅(%)'] = np.where(final['P20'] > 0, round((final['當日收盤價'] - final['P20']) / final['P20'] * 100, 2), 0)

    display_cols = ['代號', '名稱', '當日收盤價',
                    '當日買賣超金額(萬元)', '5日買賣超金額(萬元)', '1個月買賣超金額(萬元)',
                    '當日漲幅(%)', '5日漲幅(%)', '1個月漲幅(%)',
                    '當日買超(張)', '5日買超(張)', '1個月買超(張)']
    final = final[display_cols].sort_values(by='當日買賣超金額(萬元)', ascending=False).reset_index(drop=True)
    final.to_csv(final_cache_path, index=False, encoding='utf-8-sig')
    print(f"  ✅ {date_str} 完成({len(final)}檔,觀測基準日 {latest_d})")
    return final

# ═══════════════ 寫回 GitHub repo ═══════════════
def gh_put_file(repo_path, content_bytes, message):
    """上傳檔案到 repo(含 sha 衝突重試)"""
    url = f"{API}/contents/{repo_path}"
    for attempt in range(6):
        sha = None
        r = requests.get(f"{url}?ref={BRANCH}", headers=GH_HEADERS, timeout=20)
        if r.status_code == 200:
            sha = r.json().get("sha")
        body = {"message": message, "content": base64.b64encode(content_bytes).decode(),
                "branch": BRANCH}
        if sha: body["sha"] = sha
        put = requests.put(url, headers=GH_HEADERS, data=json.dumps(body), timeout=30)
        if put.status_code in (200, 201):
            return True
        if put.status_code in (409, 422):
            time.sleep(0.5 * (attempt+1)); continue
        print(f"    寫入失敗 {put.status_code}: {put.text[:200]}"); return False
    return False

# ═══════════════ 主流程 ═══════════════
def daterange(start_str, end_str):
    s = datetime.datetime.strptime(start_str, "%Y%m%d").date()
    e = datetime.datetime.strptime(end_str, "%Y%m%d").date()
    d = s
    while d <= e:
        if d.weekday() < 5:   # 只跑工作日
            yield d
        d += timedelta(days=1)

def main():
    print(f"▶ 抓取歷史 final_output {START} ~ {END}  repo={REPO}")
    days = list(daterange(START, END))
    print(f"  工作日 {len(days)} 天")
    ok = 0; skip = 0; fail = 0
    t0 = time.time()
    for i, d in enumerate(days):
        ds = d.strftime("%Y%m%d")
        print(f"[{i+1}/{len(days)}] {ds} 抓取中…  (已耗時 {int(time.time()-t0)}s)")
        # 安全閥:Actions 6 小時上限,跑超過 5 小時就停,避免被硬砍
        if time.time() - t0 > 5*3600:
            print("⏱ 已接近 5 小時,提前停止(剩餘日期下次再跑)"); break
        try:
            df = run_engine(d)
            if df is None or df.empty:
                fail += 1; continue
            # 寫回 repo: data/raw/final_output_YYYYMMDD.csv
            csv_bytes = df.to_csv(index=False, encoding='utf-8-sig').encode('utf-8-sig')
            if gh_put_file(f"data/raw/final_output_{ds}.csv", csv_bytes, f"history {ds}"):
                ok += 1
            else:
                fail += 1
        except Exception as e:
            print(f"  ❌ {ds} 例外: {e}"); fail += 1
    print(f"\n✅ 完成:成功 {ok} 天,失敗 {fail} 天,總耗時 {int(time.time()-t0)}s")

if __name__ == "__main__":
    main()
