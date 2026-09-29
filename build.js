#!/usr/bin/env node
// server.js ve index.html'i tek bir tasinabilir uygulama haline getirir (Node'un
// yerlesik Single Executable Application ozelligi ile):
//   Windows -> dist/ClaudeLimits.exe
//   macOS   -> dist/ClaudeLimits.app
// Calisma zamani mantiginda hicbir degisiklik yapmaz; sadece paketleme
// adimlarini otomatikler. Her platform kendi ciktisini uretir (capraz derleme yok).

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const DIST_DIR = path.join(ROOT, 'dist');
const APP_NAME = 'ClaudeLimits';
const BLOB_PATH = path.join(ROOT, 'sea-prep.blob');
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const VERSION = require('./package.json').version;

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function makeSeaBlob() {
  try {
    run(process.execPath, ['--experimental-sea-config', 'sea-config.json']);
  } catch {
    console.error(
      '\nSEA blob uretilemedi. Bu node ikilisi Single Executable Application destegi\n' +
      'olmadan derlenmis olabilir (ornegin Homebrew node). nodejs.org\'daki resmi node ile\n' +
      'tekrar deneyin.'
    );
    process.exit(1);
  }
}

function injectBlob(binPath, extraArgs = []) {
  const args = ['--yes', 'postject', binPath, 'NODE_SEA_BLOB', BLOB_PATH, '--sentinel-fuse', SEA_FUSE, ...extraArgs];
  if (process.platform === 'win32') {
    // npx Windows'ta bir .cmd oldugu icin shell gerekiyor; bosluk iceren
    // yollar bolunmesin diye argumanlari tirnakliyoruz.
    run('npx', args.map((a) => `"${a}"`), { shell: true });
  } else {
    run('npx', args);
  }
  fs.rmSync(BLOB_PATH, { force: true });
}

function buildWindows() {
  const exePath = path.join(DIST_DIR, `${APP_NAME}.exe`);

  console.log('1/5 SEA blob uretiliyor...');
  makeSeaBlob();

  console.log('2/5 node.exe kopyalaniyor...');
  fs.copyFileSync(process.execPath, exePath);

  console.log('3/5 imza kaldiriliyor (varsa)...');
  try {
    run('signtool', ['remove', '/s', exePath]);
  } catch {
    console.log('   signtool bulunamadi veya imza yok, devam ediliyor.');
  }

  console.log('4/5 blob exe icine gomuluyor (postject)...');
  injectBlob(exePath);

  console.log('5/5 konsol penceresi gizleniyor (PE subsystem -> GUI)...');
  hideConsoleWindow(exePath);

  return exePath;
}

function buildMac() {
  const appDir = path.join(DIST_DIR, `${APP_NAME}.app`);
  const macosDir = path.join(appDir, 'Contents', 'MacOS');
  const binPath = path.join(macosDir, APP_NAME);

  warnIfNotPortable();

  console.log('1/5 SEA blob uretiliyor...');
  makeSeaBlob();

  console.log('2/5 .app paketi olusturuluyor...');
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(macosDir, { recursive: true });
  fs.copyFileSync(process.execPath, binPath);
  fs.chmodSync(binPath, 0o755);
  fs.writeFileSync(path.join(appDir, 'Contents', 'Info.plist'), infoPlist());

  console.log('3/5 node imzasi kaldiriliyor...');
  run('codesign', ['--remove-signature', binPath]);

  console.log('4/5 blob ikili dosyaya gomuluyor (postject)...');
  injectBlob(binPath, ['--macho-segment-name', 'NODE_SEA']);

  console.log('5/5 ad-hoc imzalaniyor...');
  // Indirilen node'dan gelen quarantine/provenance oznitelikleri codesign'i
  // "resource fork ... not allowed" hatasiyla durduruyor.
  run('xattr', ['-cr', appDir]);
  run('codesign', ['--sign', '-', '--force', binPath]);
  run('codesign', ['--sign', '-', '--force', appDir]);

  return appDir;
}

// LSUIElement: sunucu surecinin Dock'ta ayrica bir ikonu olmasin; kullanicinin
// gordugu pencere zaten tarayicinin --app penceresi.
function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Claude Limits</string>
  <key>CFBundleDisplayName</key><string>Claude Limits</string>
  <key>CFBundleIdentifier</key><string>com.mer4t.claudelimits</string>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;
}

// Homebrew'un node'u libnode/openssl/icu gibi kutuphanelere dinamik bagli
// gelir; kopyalanan ikili o kutuphaneler olmayan bir Mac'te acilmaz.
// nodejs.org'dan indirilen resmi node ise statik bagli ve tasinabilir.
function warnIfNotPortable() {
  let libs = '';
  try {
    libs = execFileSync('otool', ['-L', process.execPath], { encoding: 'utf8' });
  } catch {
    return;
  }
  if (/\/(opt\/homebrew|usr\/local\/(opt|Cellar))\//.test(libs)) {
    console.warn(
      'UYARI: Bu node ikilisi Homebrew kutuphanelerine bagli; uretilen .app baska\n' +
      'Mac\'lerde calismayabilir. Dagitim icin nodejs.org\'daki resmi node ile build alin.\n'
    );
  }
}

// node.exe, calisma zamaninda kullanilan gercek node ikilisinin bir kopyasi
// oldugu icin "console subsystem" olarak isaretli gelir; bu da cift
// tiklandiginda arka planda bir konsol penceresi acilmasina neden olur.
// editbin.exe (Visual Studio Build Tools) burada kurulu degil, bu yuzden
// PE optional header'indaki Subsystem alanini (IMAGE_SUBSYSTEM_WINDOWS_CUI=3
// -> IMAGE_SUBSYSTEM_WINDOWS_GUI=2) dogrudan patchliyoruz; editbin'in yaptigi
// da tam olarak bu. Bu alanin offseti PE32 ve PE32+ (64-bit) icin ikisinde de
// ayni (Optional Header + 68 byte), cunku PE32+'ta BaseOfData alani (4 byte)
// kalkiyor ama ImageBase 4 byte yerine 8 byte oluyor; net fark sifir.
function hideConsoleWindow(exePath) {
  const buf = fs.readFileSync(exePath);
  if (buf.readUInt16LE(0) !== 0x5a4d) {
    throw new Error('Gecerli bir PE dosyasi degil (MZ imzasi yok).');
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error('Gecerli bir PE dosyasi degil (PE imzasi yok).');
  }
  const optionalHeaderOffset = peOffset + 4 /* "PE\0\0" */ + 20 /* COFF header */;
  const subsystemOffset = optionalHeaderOffset + 68;
  const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
  const current = buf.readUInt16LE(subsystemOffset);
  if (current === IMAGE_SUBSYSTEM_WINDOWS_GUI) {
    console.log('   Subsystem zaten GUI, degisiklik gerekmiyor.');
    return;
  }
  buf.writeUInt16LE(IMAGE_SUBSYSTEM_WINDOWS_GUI, subsystemOffset);
  fs.writeFileSync(exePath, buf);
}

const builders = { win32: buildWindows, darwin: buildMac };
const build = builders[process.platform];
if (!build) {
  console.error(`Bu build script sadece Windows ve macOS icin yazildi (su an: ${process.platform}).`);
  process.exit(1);
}

fs.mkdirSync(DIST_DIR, { recursive: true });
const output = build();
console.log(`\nHazir: ${output}`);
