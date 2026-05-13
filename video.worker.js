name: Remote Browser

on:
  workflow_dispatch:

permissions:
  contents: write

jobs:

  worker:

    runs-on: ubuntu-latest

    timeout-minutes: 360

    steps:

      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          persist-credentials: true

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm install

      - name: Install Playwright Chromium
        run: npx playwright install --with-deps chromium

      - name: Configure git
        run: |
          git config user.name "github-actions"
          git config user.email "github-actions@github.com"

      - name: Persistent supervisor
        run: |
          while true
          do

            git pull --rebase origin main || true

            node dispatcher.js || true

            sleep 2

          done
