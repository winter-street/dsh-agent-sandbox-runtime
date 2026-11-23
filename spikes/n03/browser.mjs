import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function openBrowser(directory, token, modulePath, executablePath) {
  const { chromium } = await import(pathToFileURL(modulePath).href);
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let runId;
    const wait = (id, text) => page.waitForFunction(({ id, text }) => document.getElementById(id)?.textContent.includes(text), { id, text }, { timeout: 12000 });
    const login = async () => {
      await page.locator('#token').fill(token);
      await page.locator('#login-form button').click();
      await wait('run-id', runId);
      await wait('status', '执行中');
    };
    return {
      async start(url, id) { runId = id; await page.goto(url); await login(); },
      async reload() {
        await page.reload(); await login();
        assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
        await page.screenshot({ path: join(directory, 'running.png'), fullPage: true });
      },
      offline: value => context.setOffline(value),
      async finish(artifacts) {
        await wait('status', '已完成并验证');
        await wait('events', 'workflow.role_completed');
        const downloads = [];
        for (const artifact of artifacts) {
          const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('#artifacts button').filter({ hasText: artifact.path }).click()]);
          assert.equal(download.suggestedFilename(), artifact.path);
          const bytes = await readFile(await download.path());
          const hash = createHash('sha256').update(bytes).digest('hex');
          assert.equal(hash, artifact.sha256); downloads.push({ path: artifact.path, sha256: hash });
        }
        await page.screenshot({ path: join(directory, 'complete-desktop.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: join(directory, 'complete-mobile.png'), fullPage: true });
        assert.deepEqual(errors, []);
        return { browser: browser.version(), reloadWhileRunning: true, reconnectAcrossProcessRestart: true, downloads, screenshots: 3 };
      },
      close: () => browser.close(),
    };
  } catch (error) { await browser.close(); throw error; }
}
