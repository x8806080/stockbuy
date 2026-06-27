name: 抓取大盤月資料

on:
  workflow_dispatch:
  # schedule:
  #   - cron: '30 9 * * 1-5'  # 台灣17:30自動跑(收盤後)

permissions:
  contents: write

jobs:
  fetch-taiex:
    runs-on: ubuntu-latest
    steps:
      - name: 取出程式碼
        uses: actions/checkout@v4
      - name: 安裝 Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: 抓取最新月大盤
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          TARGET_BRANCH: ${{ github.ref_name }}
        run: node fetch_taiex.mjs
