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
    if (existsSync(candidate)) {
      return { command: candidate, desktopExePath: candidate };
    }
  }

  const fallback =
    explicitDesktopExe?.trim() || process.env.WORKBENCH_DESKTOP_EXE?.trim() || process.execPath;
  return {
    command: fallback,
    desktopExePath: isPackagedWorkbenchExe(fallback) ? fallback : null,
  };
}

export function formatTomlString(value: string): string {
  if (!/['\r\n\x00-\x1f\x7f]/.test(value)) {
    return `'${value}'`;
  }
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
  if (!existingText || !existingText.trim()) {
    return `${managedBlock}\n`;
  }
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

function buildWorkspaceAgentsMarkdown(): string {
  return `# 浏览器工作台（Browser Workbench）AI 专属工作区

本文件夹是「浏览器工作台（Browser Workbench）」的固定 AI 专属工作夹，同时支持 **Google Antigravity** 与 **OpenAI Codex**，且仅在打开本文件夹的 AI 窗口内生效，不会影响其他项目窗口。

## 核心协作规则

1. **优先调用工作台专属 MCP 工具（\`wb_*\`）**：
   - 凡涉及查看在线受控 Chrome 浏览器与已登录 Facebook 专页/账号、活跃账号任务组合（浏览视频/动态/商城、通过好友、发帖）与全局执行记录、读取排期表（\`.xlsx\` / \`.csv\`）、Facebook 小组立即或定时发帖、小组/专页顶贴、拉人进群、蓝蝶模拟器（BlueStacks 小组顶贴与专页顶贴、声音开关与参数配置）控制，或使用已登录受控浏览器执行外部网页操作，**必须使用 \`browser_workbench\` / \`workbench\` MCP 服务提供的 \`wb_*\` 工具**。
   - **禁止误用通用桌面截图点击（Computer Use）或未挂载工作台协议的普通内置浏览器插件去盲目操控屏幕**。
2. **严格遵守操作手册与真实状态核验**：
   - 执行任务前请先阅读并遵循 [\`.agents/skills/workbench-operator/SKILL.md\`](./.agents/skills/workbench-operator/SKILL.md) 中的三层执行策略（优先原生零 Token 模块 -> 零 Token 自然浏览 \`browseSeconds\` -> 按需网页交互 \`wb_browser_*\`）。
   - 严禁把“任务已提交/排队”等同于“发帖已成功”；必须依据真实回执（\`postUrl\`、\`postedCount\`、\`pendingReviewOperations\`、\`wb_diagnose\` 日志）向用户汇报准确状态。
   - 遇到任何验证码（CAPTCHA）或双重验证（2FA / Checkpoint）严禁自动点击或绕过，请调用 \`wb_browser_act(action="bring_to_front")\` 交由人工完成。
3. **保护用户业务文件**：
   - 用户可将排期表格（\`.xlsx\` / \`.csv\`）、文案、图片、视频素材直接放入本工作夹或子目录中；可直接通过 \`wb_read_table\` 与 \`wb_poster_save_material\` 读取，未经用户明确要求不得擅自修改或删除用户的业务文件。
4. **Codex 首次打开提示**：
   - 如果当前在 OpenAI Codex 中尚未看到 \`wb_*\` 工具，请提示用户将本文件夹（\`AI-Workspace\`）标记为 **受信任（Trusted）** 后重新开始对话，以加载 [\`.codex/config.toml\`](./.codex/config.toml) 中的项目级 MCP 服务。
`;
}

function buildUsageGuideText(targetDir: string): string {
  return `======================================================================
  浏览器工作台（Browser Workbench）— AI 专属工作夹使用说明
======================================================================

当前固定工作夹路径：
  ${targetDir}

一、为什么使用固定 AI 专属工作夹？
  1. 窗口级隔离：只有在 Antigravity 或 Codex 中打开本文件夹的窗口才会加载「浏览器工作台」控制工具，您平时写代码或处理其他工作的窗口完全不受影响、不串台。
  2. 零环境依赖：直接使用浏览器工作台自带引擎运行，电脑无需额外安装 Node.js 或配置环境变量。
  3. 自动同步更新：每次启动或热更新「浏览器工作台」时，本工作夹内的 AI 插件与技能规则会自动保持最新，不会删除您放在这里的排期表或素材文件。

二、在 Google Antigravity 中使用（2 步即用）
  1. 打开 Antigravity -> 选择「File -> Open Folder（打开文件夹）」，打开本文件夹（AI-Workspace）。
  2. 直接在右侧对话框发送指令即可，例如：
     - “帮我看下现在有哪些在线浏览器，分别登录了什么 Facebook 专页？”
     - “按照工作夹里的排期表，晚上 20:30 给对应专页和小组定时发帖。”

三、在 OpenAI Codex（桌面版 / CLI）中使用（2 步即用）
  1. 打开 Codex -> 选择打开项目文件夹（Open Folder），选择本文件夹（AI-Workspace）。
  2. 首次打开弹出信任提示时，请选择「Trust（信任此项目）」（Codex 仅对受信任项目加载 .codex/config.toml 中的本地 MCP 工具），之后即可直接在对话框下达指令。

四、日常素材与排期表摆放建议
  - 您可以把日常发帖用的 Excel（.xlsx）/ CSV 排期表、图片、视频直接放进本文件夹（或在此新建子文件夹分类存放），在对话里直接说文件名，AI 就能自动读取并核对！
`;
}

export async function syncProductAiWorkspaceDirectory(options: {
  rootDir: string;
  softwareVersion: string;
  targetDir?: string;
  desktopExePath?: string;
}): Promise<{ directory: string; synced: boolean; command: string }> {
  const targetDir = options.targetDir ?? productAiWorkspaceDirectory();
  const bundledDir = path.join(options.rootDir, 'config', 'ai-workspace');
  const stdioSourcePath = path.join(bundledDir, 'workbench-mcp-stdio.mjs');
  const skillSourcePath = path.join(bundledDir, 'SKILL.md');

  const [stdioBytes, skillBytes] = await Promise.all([
    readFile(stdioSourcePath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    }),
    readFile(skillSourcePath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    }),
  ]);

  if (!stdioBytes || !skillBytes) {
    return { directory: targetDir, synced: false, command: '' };
  }

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
      '控制在线 Chrome 浏览器与蓝蝶模拟器：支持活跃账号任务组合与全局执行记录、自动匹配专页与小组定时发帖、Chrome 与蓝蝶小组/专页顶贴、邀请人、读取 Excel/CSV 排期表及通用网页自动化。',
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
    { relPath: 'AGENTS.md', bytes: Buffer.from(buildWorkspaceAgentsMarkdown(), 'utf8') },
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
    {
      relPath: path.join('.codex', 'config.toml'),
      bytes: Buffer.from(nextCodexToml, 'utf8'),
    },
    {
      relPath: '使用说明.txt',
      bytes: Buffer.from(buildUsageGuideText(targetDir).replace(/\r?\n/g, '\r\n'), 'utf8'),
    },
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
