import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
const CODEX_MANAGED_START = '# >>> browser-workbench-mcp-start >>>';
const CODEX_MANAGED_END = '# <<< browser-workbench-mcp-end <<<';
export function productAiWorkspaceDirectory(): string {
  const override = process.env.WORKBENCH_AI_WORKSPACE_DIR?.trim();
  return override
    ? path.resolve(override)
    : path.join(homedir(), 'Documents', 'Browser Workbench', 'AI-Workspace');
}
function isPackagedWorkbenchExe(filePath: string): boolean {
  const base = path.basename(filePath);
  return Boolean(base) && !/^(?:node|electron)(?:\.exe)?$/i.test(base);
}
export function resolveAiWorkspaceMcpExecutable(explicitDesktopExe?: string): {
  command: string;
  desktopExePath: string | null;
} {
  const directCandidates = [
    explicitDesktopExe?.trim() ?? '',
    process.env.WORKBENCH_DESKTOP_EXE?.trim() ?? '',
    process.execPath,
  ].filter(Boolean);
  for (const candidate of directCandidates) {
    if (isPackagedWorkbenchExe(candidate) && existsSync(candidate)) {
      return { command: candidate, desktopExePath: candidate };
    }
  }
  const home = homedir();
  const localAppData = process.env.LOCALAPPDATA?.trim() ?? '';
  const installedCandidates = [
    home
      ? path.join(
          home,
          'AppData',
          'Local',
          'Programs',
          'Browser Workbench',
          'Browser Workbench.exe',
        )
      : '',
    localAppData
      ? path.join(localAppData, 'Programs', 'Browser Workbench', 'Browser Workbench.exe')
      : '',
  ].filter(Boolean);
  for (const candidate of installedCandidates) {
    if (existsSync(candidate)) return { command: candidate, desktopExePath: candidate };
  }
  const fallback =
    explicitDesktopExe?.trim() || process.env.WORKBENCH_DESKTOP_EXE?.trim() || process.execPath;
  return { command: fallback, desktopExePath: isPackagedWorkbenchExe(fallback) ? fallback : null };
}
export function formatTomlString(value: string): string {
  if (!/['\r\n\x00-\x1f\x7f]/.test(value)) return `'${value}'`;
  return JSON.stringify(value);
}
function buildCodexManagedBlock(
  command: string,
  stdioScriptPath: string,
  desktopExePath: string | null,
): string {
  const lines = [
    CODEX_MANAGED_START,
    '[mcp_servers.browser_workbench]',
    `command = ${formatTomlString(command)}`,
    `args = [${formatTomlString(stdioScriptPath)}]`,
    'startup_timeout_sec = 35',
    'tool_timeout_sec = 600',
    '',
    '[mcp_servers.browser_workbench.env]',
    'ELECTRON_RUN_AS_NODE = "1"',
    ...(desktopExePath ? [`WORKBENCH_EXE_PATH = ${formatTomlString(desktopExePath)}`] : []),
    CODEX_MANAGED_END,
  ];
  return lines.join('\n');
}
export function mergeCodexConfigToml(existingText: string | null, managedBlock: string): string {
  if (!existingText || !existingText.trim()) return `${managedBlock}\n`;
  const startIdx = existingText.indexOf(CODEX_MANAGED_START);
  const endIdx = existingText.indexOf(CODEX_MANAGED_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existingText.slice(0, startIdx);
    const after = existingText.slice(endIdx + CODEX_MANAGED_END.length);
    const merged = `${before}${managedBlock}${after}`;
    return merged.endsWith('\n') ? merged : `${merged}\n`;
  }
  const trimmed = existingText.trimEnd();
  return `${trimmed}\n\n${managedBlock}\n`;
}
export async function syncProductAiWorkspaceDirectory(options: {
  rootDir: string;
  softwareVersion: string;
  targetDir?: string;
  desktopExePath?: string;
}): Promise<{ directory: string; synced: boolean; command: string }> {
  const targetDir = options.targetDir ?? productAiWorkspaceDirectory();
  const bundledDir = path.join(options.rootDir, 'config', 'ai-workspace');
  const readOptional = (file: string) =>
    readFile(path.join(bundledDir, file)).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
  const [stdioBytes, skillBytes, agentsBytes, usageGuideBytes] = await Promise.all([
    readOptional('workbench-mcp-stdio.mjs'),
    readOptional('SKILL.md'),
    readOptional('AGENTS.md'),
    readOptional('usage-guide.txt'),
  ]);
  if (!stdioBytes || !skillBytes || !agentsBytes || !usageGuideBytes) {
    return { directory: targetDir, synced: false, command: '' };
  }
  const usageGuideText = usageGuideBytes
    .toString('utf8')
    .replace('{{TARGET_DIR}}', targetDir)
    .replace(/\r?\n/g, '\r\n');
  const { command, desktopExePath } = resolveAiWorkspaceMcpExecutable(options.desktopExePath);
  const targetStdioPath = path.join(
    targetDir,
    '.agents',
    'plugins',
    'browser-workbench',
    'workbench-mcp-stdio.mjs',
  );
  const pluginManifest = {
    name: 'browser-workbench',
    version: options.softwareVersion,
    displayName: '浏览器工作台（Browser Workbench）',
    description:
      '控制在线 Chrome 浏览器与蓝蝶模拟器：支持定时排班无人值守流水线、活跃账号任务组合与全局执行记录、自动匹配专页与小组定时发帖、Chrome 与蓝蝶小组/专页顶贴、邀请人、读取 Excel/CSV 排期表及通用网页自动化。',
    mcpServers: './mcp_config.json',
    suggestedPrompts: [
      {
        title: '查看在线浏览器与专页状态',
        prompt:
          '帮我看下现在有哪些在线浏览器，分别登录了什么 Facebook 专页或账号，有没有受限或待核对记录？',
      },
      {
        title: '按排期表格设置专页与小组定时发帖',
        prompt:
          '读取当前工作夹里的排期表格，匹配对应的在线专页浏览器与目标小组，检查素材后创建定时发帖任务并汇报排期核对结果。',
      },
      {
        title: '排查任务异常或卡住原因',
        prompt: '帮我检查当前工作台有没有卡住、报错或待核对的任务，调取诊断日志给出真实原因。',
      },
    ],
  };
  const antigravityMcpConfig = {
    mcpServers: {
      workbench: {
        command,
        args: [targetStdioPath],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          ...(desktopExePath ? { WORKBENCH_EXE_PATH: desktopExePath } : {}),
        },
      },
    },
  };
  const codexTomlPath = path.join(targetDir, '.codex', 'config.toml');
  const existingCodexToml = await readFile(codexTomlPath, 'utf8').catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    },
  );
  const nextCodexToml = mergeCodexConfigToml(
    existingCodexToml,
    buildCodexManagedBlock(command, targetStdioPath, desktopExePath),
  );
  const filesToSync: { relPath: string; bytes: Buffer }[] = [
    { relPath: 'AGENTS.md', bytes: agentsBytes },
    {
      relPath: path.join('.agents', 'skills', 'workbench-operator', 'SKILL.md'),
      bytes: skillBytes,
    },
    {
      relPath: path.join('.agents', 'plugins', 'browser-workbench', 'workbench-mcp-stdio.mjs'),
      bytes: stdioBytes,
    },
    {
      relPath: path.join('.agents', 'plugins', 'browser-workbench', 'plugin.json'),
      bytes: Buffer.from(`${JSON.stringify(pluginManifest, null, 2)}\n`, 'utf8'),
    },
    {
      relPath: path.join('.agents', 'plugins', 'browser-workbench', 'mcp_config.json'),
      bytes: Buffer.from(`${JSON.stringify(antigravityMcpConfig, null, 2)}\n`, 'utf8'),
    },
    { relPath: path.join('.codex', 'config.toml'), bytes: Buffer.from(nextCodexToml, 'utf8') },
    { relPath: '使用说明.txt', bytes: Buffer.from(usageGuideText, 'utf8') },
  ];
  await mkdir(targetDir, { recursive: true });
  const changed: { target: string; before: Buffer | null }[] = [];
  try {
    for (const item of filesToSync) {
      const target = path.join(targetDir, item.relPath);
      const before = await readFile(target).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      if (before?.equals(item.bytes)) continue;
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, item.bytes);
        await rename(temporary, target);
        changed.push({ target, before });
      } finally {
        await rm(temporary, { force: true });
      }
    }
  } catch (err) {
    for (const row of changed.reverse()) {
      if (row.before) await writeFile(row.target, row.before);
      else await rm(row.target, { force: true });
    }
    throw err;
  }
  return { directory: targetDir, synced: true, command };
}
