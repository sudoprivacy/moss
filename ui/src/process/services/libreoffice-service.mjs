import { execFile, exec } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { app } from 'electron';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const LIBREOFFICE_VERSION = '26.2.1';

function getArchNames() {
  if (process.arch === 'arm64') {
    return { dir: 'aarch64', file: 'aarch64' };
  }
  return { dir: 'x86_64', file: 'x86-64' };
}

export class LibreOfficeService {
  async checkInstalled() {
    if (process.platform === 'darwin') return this.checkInstalledMac();
    if (process.platform === 'win32') return this.checkInstalledWindows();
    return this.checkInstalledLinux();
  }

  async checkInstalledMac() {
    const appPath = '/Applications/LibreOffice.app';
    if (!fs.existsSync(appPath)) return { installed: false };
    try {
      const { stdout } = await execAsync(`defaults read "${appPath}/Contents/Info.plist" CFBundleShortVersionString`);
      return { installed: true, version: stdout.trim() || undefined };
    } catch {
      return { installed: true };
    }
  }

  async checkInstalledWindows() {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const candidates = [
      path.join(programFiles, 'LibreOffice', 'program', 'soffice.exe'),
      path.join(programFilesX86, 'LibreOffice', 'program', 'soffice.exe'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return { installed: true };
    }
    return { installed: false };
  }

  async checkInstalledLinux() {
    try {
      const { stdout } = await execAsync('which libreoffice 2>/dev/null || which soffice 2>/dev/null');
      return { installed: Boolean(stdout.trim()) };
    } catch {
      return { installed: false };
    }
  }

  getDownloadUrl() {
    const { file } = getArchNames();
    const base = 'https://sudoclaw-1309794936.cos.ap-beijing.myqcloud.com/sudoclaw';
    if (process.platform === 'darwin') {
      return `${base}/LibreOffice_${LIBREOFFICE_VERSION}_MacOS_${file}.dmg`;
    }
    if (process.platform === 'win32') {
      return `${base}/LibreOffice_${LIBREOFFICE_VERSION}_Win_${file}.msi`;
    }
    return `${base}/LibreOffice_${LIBREOFFICE_VERSION}_Linux_${file}_deb.tar.gz`;
  }

  getCachedFilePath() {
    const cacheDir = path.join(app.getPath('userData'), 'libreoffice-cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const ext = process.platform === 'darwin' ? 'dmg' : process.platform === 'win32' ? 'msi' : 'tar.gz';
    return path.join(cacheDir, `LibreOffice_${LIBREOFFICE_VERSION}.${ext}`);
  }

  async install(onProgress) {
    const cachedFilePath = this.getCachedFilePath();
    if (fs.existsSync(cachedFilePath) && fs.statSync(cachedFilePath).size > 0) {
      onProgress('downloading', 90);
      if (process.platform === 'darwin') return this.installMacFromFile(cachedFilePath, onProgress);
      if (process.platform === 'win32') return this.installWindowsFromFile(cachedFilePath, onProgress);
      return this.installLinuxFromFile(cachedFilePath, onProgress);
    }
    return this.installFromLocalFile(await this.downloadToCache(onProgress), onProgress);
  }

  async installFromLocalFile(filePath, onProgress) {
    if (process.platform === 'darwin') return this.installMacFromFile(filePath, onProgress);
    if (process.platform === 'win32') return this.installWindowsFromFile(filePath, onProgress);
    return this.installLinuxFromFile(filePath, onProgress);
  }

  async uninstall() {
    if (process.platform === 'darwin') {
      const appPath = '/Applications/LibreOffice.app';
      if (fs.existsSync(appPath)) fs.rmSync(appPath, { recursive: true, force: true });
    } else if (process.platform === 'win32') {
      const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
      const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
      for (const dir of [path.join(programFiles, 'LibreOffice'), path.join(programFilesX86, 'LibreOffice')]) {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      }
    } else {
      await execAsync('pkexec dpkg -r libreoffice-common libreoffice-core 2>/dev/null || true');
    }
    const cacheDir = path.join(app.getPath('userData'), 'libreoffice-cache');
    if (fs.existsSync(cacheDir)) fs.rmSync(cacheDir, { recursive: true, force: true });
  }

  async downloadToCache(onProgress) {
    const filePath = this.getCachedFilePath();
    await this.downloadFile(this.getDownloadUrl(), filePath, (percent) => {
      onProgress('downloading', percent);
    });
    return filePath;
  }

  async installMacFromFile(filePath, onProgress) {
    let mountPoint;
    try {
      onProgress('mounting', 92);
      mountPoint = await this.mountDmg(filePath);
      onProgress('copying', 96);
      const appEntry = fs.readdirSync(mountPoint).find((entry) => entry.endsWith('.app'));
      if (!appEntry) throw new Error('No .app found in mounted DMG');
      const src = path.join(mountPoint, appEntry).replace(/'/g, "'\\''");
      const script = `do shell script "cp -R '${src}' '/Applications/'" with administrator privileges`;
      await execFileAsync('osascript', ['-e', script]);
    } finally {
      if (mountPoint) {
        onProgress('unmounting', 98);
        try {
          await execFileAsync('hdiutil', ['detach', mountPoint, '-quiet']);
        } catch {}
      }
      onProgress('cleanup', 100);
    }
  }

  async installWindowsFromFile(filePath, onProgress) {
    try {
      onProgress('installing', 92);
      await execFileAsync('msiexec', ['/i', filePath, '/passive', '/norestart']);
    } finally {
      onProgress('cleanup', 100);
    }
  }

  async installLinuxFromFile(filePath, onProgress) {
    const extractDir = path.join(path.dirname(filePath), `libreoffice-extract-${Date.now()}`);
    try {
      onProgress('extracting', 92);
      if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });
      await execFileAsync('tar', ['-xzf', filePath, '-C', extractDir]);
      onProgress('installing', 96);
      const debsDir = this.findDebsDir(extractDir);
      if (!debsDir) throw new Error('No DEBS directory found in LibreOffice package');
      const debPaths = fs.readdirSync(debsDir).filter((name) => name.endsWith('.deb')).map((name) => path.join(debsDir, name));
      if (debPaths.length === 0) throw new Error('No .deb files found');
      await execFileAsync('pkexec', ['dpkg', '-i', ...debPaths]);
    } finally {
      try {
        if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
      } catch {}
      onProgress('cleanup', 100);
    }
  }

  findDebsDir(extractDir) {
    try {
      for (const entry of fs.readdirSync(extractDir)) {
        const entryPath = path.join(extractDir, entry);
        if (!fs.statSync(entryPath).isDirectory()) continue;
        const debsPath = path.join(entryPath, 'DEBS');
        if (fs.existsSync(debsPath)) return debsPath;
      }
    } catch {}
    return undefined;
  }

  mountDmg(dmgPath) {
    return new Promise((resolve, reject) => {
      execFile('hdiutil', ['attach', dmgPath, '-nobrowse', '-plist'], (err, stdout) => {
        if (err) return reject(err);
        const match = stdout.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/);
        if (match?.[1]) return resolve(match[1]);
        reject(new Error('Could not determine DMG mount point'));
      });
    });
  }

  downloadFile(url, dest, onPercent) {
    return new Promise((resolve, reject) => {
      const doRequest = (currentUrl, redirectCount = 0) => {
        if (redirectCount > 10) return reject(new Error('Too many redirects'));
        const mod = currentUrl.startsWith('https') ? https : http;
        mod.get(currentUrl, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return doRequest(res.headers.location, redirectCount + 1);
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
          }
          const total = parseInt(res.headers['content-length'] ?? '0', 10);
          let received = 0;
          const file = fs.createWriteStream(dest);
          res.on('data', (chunk) => {
            received += chunk.length;
            if (total > 0) onPercent(Math.round((received / total) * 100));
          });
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
          file.on('error', (error) => {
            fs.rmSync(dest, { force: true });
            reject(error);
          });
          res.on('error', reject);
        }).on('error', reject);
      };
      doRequest(url);
    });
  }
}

export const libreOfficeService = new LibreOfficeService();
