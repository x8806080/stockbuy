name: 轉換CSV為分析JSON

on:
  workflow_dispatch:
    inputs:
      start:
        description: '起始日 YYYYMMDD(空=全部)'
        required: false
        default: ''
      end:
        description: '結束日 YYYYMMDD(空=全部)'
        required: false
        default: ''

permissions:
  contents: write

jobs:
  convert:
    runs-on: ubuntu-latest
    timeout-minutes: 340
    steps:
      - name: 取出程式碼
        uses: actions/checkout@v4
      - name: 安裝 Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: 轉換 CSV → JSON
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          TARGET_BRANCH: ${{ github.ref_name }}
          START: ${{ github.event.inputs.start }}
          END: ${{ github.event.inputs.end }}
        run: node convert_raw.mjs
