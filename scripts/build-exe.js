// Builds dist/DiscordSweeper.exe: a single Windows executable containing
// Node.js, the server, and the web page. Run with: npm run build:exe
//
// Uses Node's built-in Single Executable Applications feature:
// https://nodejs.org/api/single-executable-applications.html

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BLOB = path.join(DIST, 'sea-prep.blob');
const EXE = path.join(DIST, 'DiscordSweeper.exe');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const POSTJECT = 'postject@1.0.0-alpha.6';

if (process.platform !== 'win32') {
  console.error('This script builds a Windows .exe and must be run on Windows.');
  process.exit(1);
}

const { execSync } = require('child_process');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
const runShell = (command) => execSync(command, { cwd: ROOT, stdio: 'inherit' });

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

console.log('1/3  Bundling the app into a blob…');
run(process.execPath, ['--experimental-sea-config', 'sea-config.json']);

console.log('2/3  Copying the Node.js runtime…');
fs.copyFileSync(process.execPath, EXE);

console.log('3/3  Injecting the app into the executable…');
runShell(`npx --yes ${POSTJECT} "${EXE}" NODE_SEA_BLOB "${BLOB}" --sentinel-fuse ${FUSE} --overwrite`);

fs.rmSync(BLOB, { force: true });
const mb = (fs.statSync(EXE).size / 1024 / 1024).toFixed(1);
console.log(`\nDone: dist/DiscordSweeper.exe (${mb} MB)`);
