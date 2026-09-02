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

console.log('1/4 SEA blob uretiliyor...');
run(process.execPath, ['--experimental-sea-config', 'sea-config.json']);

console.log('2/4 node.exe kopyalaniyor...');
fs.copyFileSync(process.execPath, EXE_PATH);

console.log('3/4 imza kaldiriliyor (varsa)...');
try {
  run('signtool', ['remove', '/s', EXE_PATH]);
} catch {
  console.log('   signtool bulunamadi veya imza yok, devam ediliyor.');
}

console.log('4/4 blob exe icine gomuluyor (postject)...');
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

console.log(`\nHazir: ${EXE_PATH}`);
