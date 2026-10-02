// Browser check for the one-question page. Build first (`npm run simple:build`),
// then: PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node simple/verify.mjs
// Playwright is not a dependency of this repo; point PLAYWRIGHT at any install.
// Serves simple/dist itself on a free port and closes it before exiting.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const here = fileURLToPath(new URL('.', import.meta.url));
const dist = join(here, 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  try {
    const body = await readFile(join(dist, path));
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures.push(what); };
// Headless Chromium renders on the CPU (SwiftShader) unless told to use the GPU.
// SOFT_GL=1, or no DRM render node (macOS, Windows), keeps the software default.
const gpuArgs = process.env.SOFT_GL === '1' || !existsSync('/dev/dri/renderD128')
  ? [] : ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ headless: true, args: gpuArgs });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const answer = () => page.evaluate(() => `${document.getElementById('big').textContent} | ${document.getElementById('line').textContent}`);
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  await page.goto(url);
  await settle();
  const first = await answer();
  console.log(`      sample answer: ${first}`);
  check(/^At \d+ \|/.test(first), 'page loads with an age as the answer');

  for (const [id, key] of [['age', 'End'], ['saved', 'End'], ['savingPerMonth', 'End'], ['spendingPerMonth', 'End']]) {
    await page.goto(url);
    await settle();
    const before = await answer();
    const valueBefore = await page.inputValue(`#${id}`);
    await page.focus(`#${id}`);
    await page.keyboard.press('ArrowRight');
    await settle();
    check((await page.inputValue(`#${id}`)) !== valueBefore, `${id}: arrow key moves the slider`);
    const t0 = Date.now();
    await page.keyboard.press(key);
    await settle();
    const after = await answer();
    check(after !== before, `${id}: moving the slider changes the answer (${Date.now() - t0} ms) -> ${after.split(' | ')[0]}`);
  }

  await page.goto(url);
  await settle();
  const tabbed = [];
  for (let k = 0; k < 5; k++) { await page.keyboard.press('Tab'); tabbed.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName)); }
  check(tabbed.join(',') === 'age,saved,savingPerMonth,spendingPerMonth,SUMMARY', `tab order reaches every control: ${tabbed.join(', ')}`);
  await page.keyboard.press('Enter');
  await settle();
  const open = await page.evaluate(() => document.getElementById('how').open);
  const how = await page.evaluate(() => document.querySelector('.how-body').innerText);
  check(open && /4\.\d% a year above inflation/.test(how) && /60% stocks/.test(how), 'explanation opens with Enter and names the assumptions');
  check(await page.locator('#chart svg path.typical').count() === 1, 'explanation draws its one chart');

  const style = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const r = Math.max(...['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'].map((k) => parseFloat(cs[k]) || 0));
      if (r > 4) bad.push(`${el.tagName}.${el.className} radius ${r}`);
      if (/gradient/.test(cs.backgroundImage)) bad.push(`${el.tagName} gradient`);
      if (cs.backdropFilter !== 'none' || cs.filter !== 'none') bad.push(`${el.tagName} filter`);
      if (cs.boxShadow !== 'none' || cs.textShadow !== 'none') bad.push(`${el.tagName} shadow`);
    }
    return { bad, bg: getComputedStyle(document.body).backgroundColor, text: document.body.innerText };
  });
  check(style.bad.length === 0, `no radius over 4px, gradient, blur, shadow or glow ${style.bad.join('; ')}`);
  check(style.bg === 'rgb(255, 255, 255)', `white background (${style.bg})`);
  check(!/\u2014/.test(style.text), 'no em dash in the page text');

  await page.evaluate(() => { document.getElementById('how').open = false; });
  await page.goto(url);
  await settle();
  await page.screenshot({ path: join(here, 'docs', 'desktop-1280x800.png') });
  const fitsDesktop = await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight);
  check(fitsDesktop, 'at 1280x800 the whole page fits on one screen');

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  phone.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await phone.goto(url);
  await phone.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await phone.screenshot({ path: join(here, 'docs', 'phone-390x844.png') });
  const noScroll = () => phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  const phoneFold = await phone.evaluate(() => ({ sliders: document.getElementById('spendingPerMonth').getBoundingClientRect().bottom, h: window.innerHeight }));
  check(await noScroll(), 'at 390 wide there is no horizontal scroll');
  check(phoneFold.sliders <= phoneFold.h, `at 390x844 the answer and all four sliders are on the first screen (last slider ends at ${Math.round(phoneFold.sliders)}px)`);
  await phone.click('summary');
  check(await noScroll(), 'at 390 wide with the explanation open there is no horizontal scroll');

  check(errors.length === 0, `no console errors or warnings ${errors.join(' / ')}`);
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
