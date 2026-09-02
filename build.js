#!/usr/bin/env node
// server.js ve index.html'i tek bir tasinabilir .exe haline getirir (Node'un
// yerlesik Single Executable Application ozelligi ile). Calisma zamani
// mantiginda hicbir degisiklik yapmaz; sadece paketleme adimlarini otomatikler.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const DIST_DIR = path.join(ROOT, 'dist');
const EXE_NAME = 'ClaudeLimits.exe';
const EXE_PATH = path.join(DIST_DIR, EXE_NAME);
const BLOB_PATH = path.join(ROOT, 'sea-prep.blob');

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

if (process.platform !== 'win32') {
  console.error('Bu build script su an sadece Windows icin yazildi.');
  process.exit(1);
}

fs.mkdirSync(DIST_DIR, { recursive: true });

console.log('1/5 SEA blob uretiliyor...');
run(process.execPath, ['--experimental-sea-config', 'sea-config.json']);

console.log('2/5 node.exe kopyalaniyor...');
fs.copyFileSync(process.execPath, EXE_PATH);

console.log('3/5 imza kaldiriliyor (varsa)...');
try {
  run('signtool', ['remove', '/s', EXE_PATH]);
} catch {
  console.log('   signtool bulunamadi veya imza yok, devam ediliyor.');
}

console.log('4/5 blob exe icine gomuluyor (postject)...');
run(
  'npx',
  [
    '--yes',
    'postject',
    EXE_PATH,
    'NODE_SEA_BLOB',
    BLOB_PATH,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
  { shell: true }
);

fs.rmSync(BLOB_PATH, { force: true });

console.log('5/5 konsol penceresi gizleniyor (PE subsystem -> GUI)...');
hideConsoleWindow(EXE_PATH);

console.log(`\nHazir: ${EXE_PATH}`);

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
