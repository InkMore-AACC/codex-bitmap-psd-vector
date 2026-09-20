import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  expect: { timeout: 10000 },
  use: {
    baseURL: 'http://127.0.0.1:18774',
    viewport: { width: 1600, height: 1000 },
    launchOptions: {
      executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      args: ['--disable-gpu', '--no-first-run'],
    },
  },
  outputDir: '../test-output/ui',
  reporter: [['list']],
});
