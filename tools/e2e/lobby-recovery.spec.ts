import { test, expect } from '@playwright/test';

test('lobby refresh recovers a missed match notification from the session',async({page})=>{
  // Deliberate client wire fixture: no account or game is created by this check.
  let activeGameId:string|null=null;let sessionReads=0;
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/session'){
      sessionReads++;
      await route.fulfill({json:{user:{id:'5ac5ff19-553c-4135-80d1-cab954eb620b',username:'RecoveryFixture'},activeGameId}});
    }else if(['/api/seeks','/api/games/live','/api/games/history'].includes(path)){
      await route.fulfill({json:{items:[],nextCursor:null}});
    }else await route.continue();
  });
  await page.goto('/');await expect(page.getByRole('heading',{name:'Find your next game'})).toBeVisible();
  await expect(page.locator('.lobby-resume')).toHaveCount(0);const before=sessionReads;
  activeGameId='e2134271-098d-4de2-ad7d-5fd5285c08ef';
  await expect(page.locator('.lobby-resume a')).toBeVisible({timeout:20000});
  expect(sessionReads).toBeGreaterThan(before);
  await expect(page.locator('.lobby-resume a')).toHaveAttribute('href',`/game/${activeGameId}`);
});
