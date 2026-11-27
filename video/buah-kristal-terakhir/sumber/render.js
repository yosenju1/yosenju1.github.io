// usage: node render.js <outdir> <scale> <t0> <t1> <fps>   or   node render.js <outdir> <scale> --times 1,5,9
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const [outdir, scaleS, a, b, fpsS] = process.argv.slice(2);
const scale = parseFloat(scaleS);
const root = __dirname;
let times = [];
if (a === '--times') times = b.split(',').map(Number);
else { const fps = parseFloat(fpsS), t0 = parseFloat(a), t1 = parseFloat(b); for (let i = 0; t0 + i / fps < t1 - 1e-6; i++) times.push(t0 + i / fps); }
fs.mkdirSync(outdir, { recursive: true });
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: Math.round(1080 * scale), height: Math.round(1920 * scale) } });
  page.on('console', m => console.log('[page]', m.text()));
  page.on('pageerror', e => console.log('[err]', e.message));
  await page.route('http://app/**', async route => {
    const p = path.join(root, new URL(route.request().url()).pathname);
    const ext = path.extname(p);
    const type = { '.js': 'text/javascript', '.html': 'text/html' }[ext] || 'application/octet-stream';
    try { route.fulfill({ body: fs.readFileSync(p), contentType: type }); } catch (e) { route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(`http://app/index.html?scale=${scale}`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 120000 });
  const st = Date.now();
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const data = await page.evaluate(t => { window.renderAt(t); return window.grab(0.93); }, t);
    const name = a === '--times' ? `t_${t.toFixed(2)}.jpg` : `${String(i).padStart(5, '0')}.jpg`;
    fs.writeFileSync(path.join(outdir, name), Buffer.from(data.split(',')[1], 'base64'));
    if (i % 24 === 0) console.log(`${outdir} ${i}/${times.length} t=${t.toFixed(2)} ${((Date.now() - st) / (i + 1)).toFixed(0)}ms/frame`);
  }
  await browser.close();
})();
