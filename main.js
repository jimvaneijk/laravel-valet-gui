const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Apps started from Finder get a bare PATH; borrow the login shell's so php/brew/valet resolve.
try {
  process.env.PATH = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'echo -n "$PATH"'], { encoding: 'utf8' }).trim().split('\n').pop();
} catch {}

const which = bin => { try { return execFileSync('/usr/bin/which', [bin], { encoding: 'utf8' }).trim(); } catch { return null; } };
const PHP = which('php');
const VALET_BIN = which('valet');

// Composer's bin/valet is either a proxy script or a symlink into vendor/laravel/valet.
function findValetPhp() {
  if (!VALET_BIN) return null;
  const dir = path.dirname(fs.realpathSync(VALET_BIN));
  return [path.join(dir, 'cli/valet.php'), path.join(dir, '../laravel/valet/cli/valet.php')].find(fs.existsSync) || null;
}
const VALET_PHP = findValetPhp();

const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function run(file, args, cwd = os.homedir()) {
  return new Promise((resolve, reject) =>
    execFile(file, args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = strip(stdout + stderr);
      err ? reject(new Error(out || err.message)) : resolve(out);
    }));
}

// Read-only commands work fine as the current user, no sudo needed.
const valet = (args, cwd) => run(PHP, ['-d', 'error_reporting=1', VALET_PHP, ...args], cwd);

// Mutating commands need root. Use passwordless sudo if `valet trust` was run, else the macOS admin prompt.
async function valetAdmin(args, cwd = os.homedir()) {
  try {
    return await run('/usr/bin/sudo', ['-n', `USER=${os.userInfo().username}`, '--preserve-env', VALET_BIN, ...args], cwd);
  } catch (e) {
    if (!/password is required|a terminal is required/.test(e.message)) throw e;
  }
  const env = `USER=${q(os.userInfo().username)} HOME=${q(os.homedir())} PATH=${q(process.env.PATH)}`;
  const cmd = `cd ${q(cwd)} && ${env} ${q(PHP)} -d error_reporting=1 ${q(VALET_PHP)} ${args.map(q).join(' ')} 2>&1`;
  const script = `do shell script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`;
  return run('/usr/bin/osascript', ['-e', script], cwd);
}

// Valet prints Symfony ASCII tables; turn them into arrays of row cells (header dropped).
const table = out => out.split('\n').filter(l => l.startsWith('|')).slice(1)
  .map(l => l.slice(1, -1).split('|').map(c => c.trim()));

function phpVersions() {
  for (const prefix of ['/opt/homebrew/opt', '/usr/local/opt']) {
    if (fs.existsSync(prefix)) return fs.readdirSync(prefix).filter(n => /^php@\d+\.\d+$/.test(n)).sort();
  }
  return [];
}

async function data() {
  if (!PHP || !VALET_PHP) throw new Error('Kon `php` of `valet` niet vinden in je PATH.');
  const [links, parked, proxies, paths, tld] = await Promise.all([
    valet(['links']), valet(['parked']), valet(['proxies']), valet(['paths']), valet(['tld']),
  ]);
  const sites = new Map();
  for (const [name, ssl, url, p, php] of table(parked)) sites.set(name, { name, ssl: !!ssl, url, path: p, php, linked: false });
  for (const [name, ssl, url, p, php] of table(links)) sites.set(name, { name, ssl: !!ssl, url, path: p, php, linked: true });
  return {
    sites: [...sites.values()].sort((a, b) => a.name.localeCompare(b.name)),
    proxies: table(proxies).map(([name, ssl, url, host]) => ({ name, ssl: !!ssl, url, host })),
    paths: JSON.parse(paths),
    tld: tld.trim(),
    phps: phpVersions(),
    home: os.homedir(),
    globalPhp: 'php@' + await run(PHP, ['-r', 'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;']),
  };
}

ipcMain.handle('data', data);
ipcMain.handle('valet', (_e, args, { cwd, admin } = {}) => (admin ? valetAdmin : valet)(args, cwd));
ipcMain.handle('pickFolder', async () => (await dialog.showOpenDialog({ properties: ['openDirectory'] })).filePaths[0]);
ipcMain.handle('openUrl', (_e, url) => /^https?:\/\//.test(url) && shell.openExternal(url));
ipcMain.handle('reveal', (_e, p) => shell.openPath(p));

app.whenReady().then(() => {
  const icon = path.join(__dirname, 'assets/icon.png');
  app.dock?.setIcon(icon);
  app.setAboutPanelOptions({ applicationName: 'Valet GUI', credits: 'Gemaakt door Jim van Eijk', copyright: `© ${new Date().getFullYear()} Jim van Eijk`, iconPath: icon });
  const win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 820, minHeight: 500, title: 'Valet', icon,
    titleBarStyle: 'hiddenInset', vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  // Updates come from GitHub Releases. A signed build installs them on quit; an unsigned
  // build can't self-install on macOS, so the sidebar also links to the release page.
  if (app.isPackaged) {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.on('update-available', info => win.webContents.send('update', info.version));
    autoUpdater.on('error', err => console.error('updater:', err.message));
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }
});
app.on('window-all-closed', () => app.quit());
