import { defineConfig, devices } from '@playwright/test';
const baseURL=process.env.BESTWORD_BASE_URL??'http://127.0.0.1:3000';
process.env.BESTWORD_E2E_RUN_ID??=Date.now().toString(36);
const chromium={name:'chromium',use:{...devices['Desktop Chrome'],...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})}};
export default defineConfig({
  testDir:'./tools/e2e',fullyParallel:false,workers:1,timeout:90000,
  expect:{timeout:12000},retries:0,
  reporter:[['list'],['html',{open:'never',outputFolder:'apps/web/test-results/report'}]],
  outputDir:'apps/web/test-results/e2e',
  use:{baseURL,trace:'retain-on-failure',screenshot:'only-on-failure',video:'off'},
  projects:process.env.BESTWORD_CROSS_BROWSER==='1'?[chromium,{name:'firefox',use:{...devices['Desktop Firefox']}},{name:'webkit',use:{...devices['Desktop Safari']}}]:[chromium],
  webServer:{command:'npm start',url:`${baseURL}/api/session`,reuseExistingServer:!process.env.CI,timeout:60000},
});
