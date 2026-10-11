#!/usr/bin/env node
// Yerel panel: Claude Code'un kendi /usage komutunun kullandigi ayni uc noktayi
// (api.anthropic.com/api/oauth/usage) makinedeki oturum jetonuyla sorgular.
// Jetonu okuma ve API'yi sorgulama mantigi VS Code eklentisiyle ortak:
// vscode-extension/src/usage.js (SEA build'inde asset olarak gomulur). Jeton
// hicbir zaman tarayiciya gonderilmez, sadece bu yerel sunucu surecinde
// kullanilir. Jeton yenileme islemini BIZ yapmiyoruz (bu, Claude Code'un kendi
// refresh token rotasyonunu bozabilir); Claude Code jetonunu yeniledikce panel
// de guncel jetonu okur.

const http = require('node:http');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { exec, execFile, spawn, spawnSync } = require('node:child_process');

// .exe/.app konsol penceresi olmadan calisirken stdout/stderr'e bagli bir
// konsol olmuyor; bu durumda console.log/error normalde sessizce yutulur ama
// bazi Windows/Node surumlerinde yazma islemi hata firlatabilir (EBADF).
// Uygulamanin bu yuzden cokmemesi icin sarmaliyoruz.
for (const stream of [process.stdout, process.stderr]) {
  if (stream) stream.on('error', () => {});
}
for (const name of ['log', 'error', 'warn']) {
  const orig = console[name].bind(console);
  console[name] = (...args) => {
    try { orig(...args); } catch { /* konsol yok, yut */ }
  };
}

let sea = null;
try {
  sea = require('node:sea');
} catch {
  // Eski Node surumu ya da SEA modulu yok; normal `node server.js` calismasinda sorun degil.
}
const isSea = !!(sea && sea.isSea && sea.isSea());
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4756;
// Varsayilan port baska bir uygulamadaysa sonraki portlar denenir.
const PORT_SCAN_COUNT = 10;
const PROBE_TIMEOUT_MS = 1500;
// Ayni anda acik birden fazla pencere/sekme Anthropic'e ayri ayri gitmesin.
const USAGE_CACHE_MS = 15000;
// Sayfa kapanirken /api/bye gonderir; sayfa yenileme de ayni olayi tetikledigi
// icin kisa bir sure bekleyip yeni istek gelmezse kapaniyoruz.
const BYE_GRACE_MS = 4000;
// Sayfalar en gec 60 saniyede bir /api/ping atar; bundan uzun sessiz kalan
// sayfa kapanmis sayilir.
const PAGE_STALE_MS = 150000;
// Paket uygulamada hic istek gelmeyen her kontrol bir "bos tur" sayilir; arka
// arkaya bu kadar bos turda sunucu kapanir (yaklasik 3 dakika). Duvar saatine
// degil tur sayisina bakiyoruz ki bilgisayar uykudan uyaninca hemen kapanmasin.
const IDLE_CHECK_MS = 30000;
const IDLE_TICKS = 6;
// Baslatilan tarayici bu sure icinde cikarsa istegi zaten calisan bir kopyaya
// devretmis demektir; pencereyi biz izleyemiyoruz.
const HANDOFF_MS = 5000;
const PROFILE_DIR = path.join(os.tmpdir(), 'claude-limits-app-profile');

function readAsset(name) {
  if (isSea) return sea.getAsset(name, 'utf8');
  return fs.readFileSync(path.join(__dirname, name), 'utf8');
}

function readPackageVersion() {
  try {
    return JSON.parse(readAsset('package.json')).version;
  } catch {
    return '0.0.0';
  }
}

// SEA icinde sadece yerlesik moduller require edilebiliyor; usage.js de
// yalnizca node: modullerini kullandigi icin onu CommonJS sarmalayicisiyle
// kendimiz calistiriyoruz.
function loadUsageModule() {
  if (!isSea) return require('./vscode-extension/src/usage.js');
  const mod = { exports: {} };
  const src = sea.getAsset('usage.js', 'utf8');
  vm.runInThisContext(`(function (exports, require, module) {${src}\n})`, { filename: 'usage.js' })(mod.exports, require, mod);
  return mod.exports;
}

async function readIndexHtml() {
  if (isSea) return sea.getAsset('index.html', 'utf8');
  return fsp.readFile(path.join(__dirname, 'index.html'), 'utf8');
}

function errorMessage(e) {
  const d = (e && e.detail) || {};
  switch (e && e.code) {
    case 'NO_CREDENTIALS':
      return d.keychain
        ? `Kimlik bilgisi bulunamadi: Keychain'de "${d.keychain}" kaydi veya ${d.path}. Once Claude Code ile en az bir kez giris yapin.`
        : `Kimlik bilgisi bulunamadi: ${d.path}. Once Claude Code ile en az bir kez giris yapin.`;
    case 'BAD_CREDENTIALS':
      return `Kimlik bilgisi okunamadi (bozuk JSON): ${d.source}`;
    case 'NO_TOKEN':
      return 'Kimlik bilgisinde oturum jetonu yok. Claude Code icinde /login ile giris yapin.';
    case 'TIMEOUT':
      return 'Anthropic API zaman asimina ugradi, tekrar denenecek.';
    case 'NETWORK':
      return `Anthropic API'ye baglanilamadi: ${d.message || ''}`;
    case 'UNAUTHORIZED':
      return 'Oturum jetonunun suresi dolmus gibi gorunuyor. Claude Code uygulamasini bir kez acip kapatin (jeton kendini yeniler), sonra panel otomatik toparlanacak.';
    case 'RATE_LIMITED':
      return 'Anthropic tarafi su an istekleri siniyor (rate limit). Panel otomatik olarak yavaslayip birazdan tekrar deneyecek.';
    case 'BAD_RESPONSE':
      return 'Anthropic API beklenmeyen bir cevap dondu, tekrar denenecek.';
    case 'API_ERROR':
      return `Anthropic API hatasi (${d.status}): ${d.body || ''}`;
    default:
      return `Beklenmeyen hata: ${(e && e.message) || e}`;
  }
}

const ERROR_STATUS = { UNAUTHORIZED: 401, RATE_LIMITED: 429, TIMEOUT: 504 };

// Kisa sureli onbellek + ayni anda gelen istekleri tek API cagrisinda
// birlestirme. Hatalar da onbelleklenir ki 429'da API'ye yuklenmeyelim.
function makeUsageCache(fetchUsage, ttlMs) {
  let cached = null;
  let inFlight = null;
  return (force) => {
    if (!force && cached && Date.now() - cached.at < ttlMs) return Promise.resolve(cached);
    if (!inFlight) {
      inFlight = Promise.resolve()
        .then(() => fetchUsage())
        .then(
          (data) => ({ status: 200, body: data }),
          (e) => ({ status: ERROR_STATUS[e && e.code] || 502, body: { error: errorMessage(e), code: (e && e.code) || null } })
        )
        .then((r) => (cached = { ...r, at: Date.now() }))
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  };
}

// DNS rebinding'e karsi Host basligi yalnizca bu makinenin adresi olabilir;
// baska sitelerden gelen istekler (Sec-Fetch-Site) de reddedilir. Boylece
// ziyaret edilen bir web sitesi ne kullanim verisini okuyabilir, ne API'ye
// istek attirabilir, ne de /api/bye ile paneli kapatabilir.
function isTrustedRequest(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

// onIdle: tum sayfalar kapandiginda (ya da uzun sure istek gelmediginde)
// cagrilir; sadece paket uygulamada verilir.
function createServer({ fetchUsage, readIndex = readIndexHtml, onIdle = null, usageCacheMs = USAGE_CACHE_MS, byeGraceMs = BYE_GRACE_MS } = {}) {
  const getUsage = makeUsageCache(fetchUsage, usageCacheMs);
  const pages = new Map(); // sayfa kimligi -> son istek zamani
  let byeTimer = null;
  let sawRequest = true;
  let idleTicks = 0;

  function pageSeen(page) {
    clearTimeout(byeTimer);
    byeTimer = null;
    sawRequest = true;
    if (page) pages.set(page, Date.now());
  }

  function pageClosed(page) {
    pages.delete(page);
    const now = Date.now();
    for (const [id, seen] of pages) {
      if (now - seen > PAGE_STALE_MS) pages.delete(id);
    }
    // Baska bir pencere hala aciksa (ornegin ikinci kez acilan uygulama) kapanma.
    if (pages.size === 0 && onIdle) {
      clearTimeout(byeTimer);
      byeTimer = setTimeout(onIdle, byeGraceMs);
    }
  }

  async function handleRequest(req, res) {
    // URL'yi Host basligiyla kurmuyoruz: bozuk bir Host degeri URL ayristirmayi
    // patlatip sureci cokertebiliyordu.
    const url = new URL(req.url || '/', 'http://localhost');
    if (!isTrustedRequest(req, server.address().port)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Erisim reddedildi');
      return;
    }
    const page = url.searchParams.get('page');

    if (url.pathname === '/api/bye') {
      if (req.method === 'POST') pageClosed(page);
      res.writeHead(204);
      res.end();
      return;
    }

    pageSeen(page);

    if (url.pathname === '/api/ping') {
      // X-Claude-Limits: ikinci kopya, portu tutanin bu panel oldugunu buradan anlar.
      res.writeHead(200, { ...JSON_HEADERS, 'X-Claude-Limits': '1' });
      res.end(JSON.stringify({ app: 'claude-limits' }));
      return;
    }

    if (url.pathname === '/api/usage') {
      const r = await getUsage(url.searchParams.has('force'));
      res.writeHead(r.status, JSON_HEADERS);
      res.end(JSON.stringify(r.body));
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      let html;
      try {
        html = await readIndex();
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('index.html bulunamadi');
        return;
      }
      const nonce = crypto.randomBytes(16).toString('base64');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(String(html).replace(/<(script|style)>/g, `<$1 nonce="${nonce}">`));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bulunamadi');
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((e) => {
      console.error('Istek islenemedi:', e && e.message);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Sunucu hatasi');
    });
  });

  server.checkIdle = () => {
    if (!onIdle) return;
    if (sawRequest) {
      sawRequest = false;
      idleTicks = 0;
      return;
    }
    if (++idleTicks >= IDLE_TICKS) onIdle();
  };

  return server;
}

function findChromiumBrowser() {
  let candidates;
  if (isWin) {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || '';
    candidates = [
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      local && path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
    ];
  } else if (isMac) {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
      'Chromium.app/Contents/MacOS/Chromium',
    ];
    const roots = ['/Applications', path.join(os.homedir(), 'Applications')];
    candidates = roots.flatMap((root) => apps.map((app) => path.join(root, app)));
  } else {
    candidates = [];
  }
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function openInDefaultBrowser(url) {
  if (isWin) exec(`start "" "${url}"`);
  else if (isMac) execFile('open', [url]);
  else execFile('xdg-open', [url], () => {});
}

// macOS'ta Chrome son pencere kapaninca kapanmaz; sunucu bir sekilde cokup
// tarayiciyi kapatamadiysa bizim profilimizle calisan pencere-siz bir Chrome
// kalir. Yeni baslatilan Chrome istegi ona devredip hemen cikiyor ve pencereyi
// izleyemiyoruz. Port bizde oldugu icin bu profili kullanan her surec artiktir.
function killOrphanBrowser() {
  if (!isMac) return;
  const pattern = `--user-data-dir=${PROFILE_DIR}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alive = () => spawnSync('/usr/bin/pgrep', ['-f', '--', pattern], { timeout: 2000 }).status === 0;
  if (!alive()) return;
  spawnSync('/usr/bin/pkill', ['-f', '--', pattern], { timeout: 2000 });
  const waitUntil = Date.now() + 3000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (alive() && Date.now() < waitUntil) Atomics.wait(pause, 0, 0, 100);
}

let browserChild = null;

function shutdown() {
  if (browserChild) {
    try { browserChild.kill(); } catch { /* zaten kapanmis */ }
  }
  process.exit(0);
}

function launchAppWindow(url, { attachLifecycle = false } = {}) {
  const browser = findChromiumBrowser();
  if (!browser) {
    // Chromium tabanli tarayici bulunamadi, varsayilan tarayicida sekme olarak ac.
    // Kapanisi /api/bye ve bosta kalma denetimi yakalar.
    openInDefaultBrowser(url);
    return;
  }
  // Ayri bir --user-data-dir ile acmazsak, tarayici zaten acikken --app bayragi
  // yok sayilip normal bir sekmede acilabiliyor; bu yuzden kendine ait bir
  // profil kullaniyoruz. Bu, kullanicinin ana tarayici profilinden bagimsizdir.
  // Ayrica bu ayri profil sayesinde spawn edilen surec, o pencereye ait
  // gercek tarayici sureci oluyor (mevcut bir Chrome'a devredilmiyor); bu da
  // pencere kapatilinca 'exit' olayini guvenilir sekilde yakalamamizi saglar.
  const args = [
    `--app=${url}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--window-size=700,620',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  // Yeni profil macOS'ta "Chrome Safe Storage" Keychain izni istemesin.
  if (isMac) args.push('--use-mock-keychain');
  const child = spawn(
    browser,
    args,
    attachLifecycle ? { stdio: 'ignore' } : { detached: true, stdio: 'ignore' }
  );
  child.on('error', (e) => {
    console.error('Tarayici baslatilamadi:', e.message);
    if (attachLifecycle) {
      browserChild = null;
      openInDefaultBrowser(url);
    }
  });
  if (attachLifecycle) {
    browserChild = child;
    const spawnedAt = Date.now();
    child.on('exit', () => {
      browserChild = null;
      // Hemen cikti: istek baska bir tarayici surecine devredildi. Kapanisi
      // /api/bye ve bosta kalma denetimi yakalar.
      if (Date.now() - spawnedAt < HANDOFF_MS) return;
      // Uygulama penceresi kapatilinca arka planda calisan yerel sunucuyu da
      // kapat; boylece process, konsol penceresi gizlendikten sonra bile
      // gorev yoneticisinde / arka planda sonsuza kadar takili kalmiyor.
      process.exit(0);
    });
  } else {
    child.unref();
  }
}

function parsePort(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  console.error(`Gecersiz PORT degeri (${value}), varsayilan ${DEFAULT_PORT} kullaniliyor.`);
  return null;
}

function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE') resolve(false);
      else reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

// Portu tutan surec bu panel mi? (ikinci kez acilma durumu)
function isOurPanel(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port, path: '/api/ping', headers: { Host: `${HOST}:${port}` }, timeout: PROBE_TIMEOUT_MS },
      (res) => {
        res.resume();
        resolve(res.headers['x-claude-limits'] === '1');
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function main() {
  const usage = loadUsageModule();
  const userAgent = `m4claudelimits/${readPackageVersion()} (local usage dashboard)`;
  // Sadece paketlenmis uygulamada (.exe/.app) pencere acilir; `node server.js`
  // ile gelistirme sirasinda her calistirmada pencere acilmasin diye.
  const shouldOpenWindow = isSea && (isWin || isMac);

  const server = createServer({
    fetchUsage: () => usage.fetchUsage({ userAgent }),
    onIdle: shouldOpenWindow ? shutdown : null,
  });

  const envPort = parsePort(process.env.PORT);
  const ports = envPort ? [envPort] : Array.from({ length: PORT_SCAN_COUNT }, (_, i) => DEFAULT_PORT + i);

  for (const port of ports) {
    let listening;
    try {
      // Sadece bu makineden erisilebilsin diye loopback'e baglaniyoruz; aksi
      // halde ayni agdaki herkes panele ve /api/usage verisine ulasabiliyordu.
      listening = await tryListen(server, port);
    } catch (err) {
      console.error('Sunucu baslatilamadi:', err.message);
      process.exit(1);
    }
    const appUrl = `http://${HOST}:${port}`;
    if (listening) {
      console.log(`Claude limitleri paneli hazir: ${appUrl}`);
      if (shouldOpenWindow) {
        setInterval(() => server.checkIdle(), IDLE_CHECK_MS).unref();
        killOrphanBrowser();
        // attachLifecycle: true -> pencere kapatilinca bu sunucu sureci de kapanir.
        launchAppWindow(appUrl, { attachLifecycle: true });
      }
      return;
    }
    if (await isOurPanel(port)) {
      console.error(`Panel zaten calisiyor (${appUrl}).`);
      if (shouldOpenWindow) launchAppWindow(appUrl);
      process.exit(0);
    }
    console.error(`Port ${port} baska bir uygulama tarafindan kullaniliyor.`);
  }
  console.error('Bos port bulunamadi; PORT ortam degiskeniyle baska bir port secin.');
  process.exit(1);
}

module.exports = { createServer, errorMessage, isTrustedRequest, parsePort };

// SEA icinde require.main tanimli olmayabilir; paket uygulamada her zaman baslat.
if (isSea || require.main === module) main();
