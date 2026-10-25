import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function requireRuntime() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 19))
    throw Error(
      '开发检查需要 Node.js 24.19 或更新版本；本机24.13构建发生过原生崩溃。正式桌面软件自带运行时，不要求用户安装Node。',
    );
}
export async function runNode(file, args = []) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(Error(file + ' failed (' + (signal ?? code) + ')')),
    );
  });
}
