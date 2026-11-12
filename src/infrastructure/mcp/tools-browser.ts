import {
  errorResult,
  okResult,
  resolveProfileId,
  resolveProfileIds,
  type McpToolDefinition,
  type WorkbenchMcpDependencies,
} from './mcp-context.js';

export function createAgentBrowserTools(deps: WorkbenchMcpDependencies): McpToolDefinition[] {
  const wbBrowserOpen: McpToolDefinition = {
    name: 'wb_browser_open',
    description:
      '在指定的真实 Chrome 浏览器（携带该浏览器已登录的 Google / Facebook / 外部站点 Cookie，绝不关闭用户原有标签页，默认后台静默不抢焦点）中打开或跳转受控 AI 临时标签页。支持传入 browseSeconds（1~600 秒）在本地零 Token 自动执行拟人滚动阅读（例如“打开某个小组浏览 3 分钟”），结束后自动返回页面可交互元素 [e1..eN] 与正文摘要。任务完成后请调用 wb_browser_close 关闭临时标签页。',
    annotations: { openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        profileId: {
          type: 'string',
          description: '目标在线浏览器的 profileId（可先通过 wb_list_profiles 查询）',
        },
        url: {
          type: 'string',
          description:
            '要访问的完整 http:// 或 https:// 网址（如 https://drive.google.com 或 Facebook 小组链接）',
        },
        foreground: {
          type: 'boolean',
          description:
            '是否将浏览器窗口置顶显示给用户（默认 false 后台静默操作；需要用户手动登录或过验证码时传 true）',
        },
        reuseSession: {
          type: 'boolean',
          description: '若该浏览器已有打开的 AI 标签页，是否直接复用跳转（默认 true）',
        },
        approvedFiles: {
          type: 'array',
          items: { type: 'string' },
          description:
            '若后续需要在该网页上传本地文件，请在此预先声明允许上传的本地文件绝对路径列表',
        },
        browseSeconds: {
          type: 'number',
          minimum: 1,
          maximum: 600,
          description:
            '可选：打开网页后在本地自动执行拟人上下滚动浏览的秒数（1~600 秒，全程 0 Token 消耗，遇到验证码自动提前停下）',
        },
        timeoutMs: {
          type: 'number',
          minimum: 3000,
          maximum: 60000,
          description: '页面导航超时毫秒数（默认 25000）',
        },
      },
      required: ['profileId', 'url'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const rawProfileId = typeof args.profileId === 'string' ? args.profileId.trim() : '';
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (!rawProfileId || !url) {
        return errorResult('INVALID_ARGS', 'profileId 与 url 均为必填项');
      }
      const profileId = await resolveProfileId(deps, rawProfileId);
      const existingPeer = deps.core.peers.get(profileId);
      if (!(existingPeer?.online && (existingPeer.browserWindowCount ?? 1) > 0)) {
        if (deps.profileLifecycle) {
          const ensured = await deps.profileLifecycle.ensureProfilesOnline([profileId], {
            timeoutMs: 35_000,
          });
          if (!ensured.readyIds.includes(profileId)) {
            const fail = ensured.failed[0];
            return errorResult(
              fail?.errorCode ?? 'BROWSER_OFFLINE',
              fail?.reason ?? '自动启动该离线浏览器未成功',
            );
          }
        }
      }
      const approvedFiles = Array.isArray(args.approvedFiles)
        ? args.approvedFiles.map((f) => String(f).trim()).filter(Boolean)
        : undefined;

      const res = await deps.agentBrowser.open({
        profileId,
        url,
        foreground: args.foreground === true,
        reuseSession: args.reuseSession !== false,
        approvedFiles,
        browseSeconds: typeof args.browseSeconds === 'number' ? args.browseSeconds : undefined,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      });

      return okResult({
        ok: true,
        ...res,
      });
    },
  };

  const wbBrowserObserve: McpToolDefinition = {
    name: 'wb_browser_observe',
    description:
      '轻量级读取指定浏览器当前 AI 标签页的 DOM 结构与状态（比截图省 90% Token）：为页面可见交互元素重新打标 [e1..eN]（按钮、链接、输入框、富文本框、下拉框），提取弹窗提示、标题、表格预览与正文文本，并检测是否存在 CAPTCHA / 双重验证 / 登录拦截（密码框内容自动脱敏为 [REDACTED]）。',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        profileId: {
          type: 'string',
          description: '已通过 wb_browser_open 打开会话的浏览器 profileId',
        },
        maxElements: {
          type: 'number',
          minimum: 5,
          maximum: 200,
          description: '最多提取的可交互元素数量（默认 80）',
        },
        includeTextChars: {
          type: 'number',
          minimum: 200,
          maximum: 16000,
          description: '最多提取的页面可见文本字符数（默认 3500）',
        },
        selectorScope: {
          type: 'string',
          description:
            '可选 CSS 选择器，仅在该容器范围内扫描交互元素与正文（例如 "[role=dialog]" 或 "main"）',
        },
      },
      required: ['profileId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const rawProfileId = typeof args.profileId === 'string' ? args.profileId.trim() : '';
      if (!rawProfileId) return errorResult('PROFILE_ID_REQUIRED', '必须提供 profileId');
      const profileId = await resolveProfileId(deps, rawProfileId);

      const observation = await deps.agentBrowser.observe({
        profileId,
        maxElements: typeof args.maxElements === 'number' ? args.maxElements : undefined,
        includeTextChars:
          typeof args.includeTextChars === 'number' ? args.includeTextChars : undefined,
        selectorScope: typeof args.selectorScope === 'string' ? args.selectorScope : undefined,
      });
      return okResult({
        ok: true,
        profileId,
        observation,
      });
    },
  };

  const wbBrowserAct: McpToolDefinition = {
    name: 'wb_browser_act',
    description:
      '在已打开的 AI 标签页中执行单步精准交互动作：click（点击）、double_click（双击）、fill（快速填入输入框或富文本框）、type（逐字敲击输入）、press（按键如 Enter/Tab/Escape）、select（下拉选择）、hover（悬停）、scroll（滚动页面或滚动到目标元素）、upload_files（向文件控件上传已在 wb_browser_open.approvedFiles 授权的文件）、wait_for_text（等待指定文字出现）、bring_to_front（置顶浏览器窗口交由人工处理登录/验证码）。内置人机验证安全护栏：遇到 CAPTCHA 严禁自动点击，自动返回人工接管提示。执行后自动返回最新页面观察结果。',
    annotations: { openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        profileId: {
          type: 'string',
          description: '浏览器 profileId',
        },
        action: {
          type: 'string',
          enum: [
            'click',
            'double_click',
            'fill',
            'type',
            'press',
            'select',
            'hover',
            'scroll',
            'upload_files',
            'wait_for_text',
            'bring_to_front',
          ],
          description: '交互动作类型',
        },
        ref: {
          type: 'string',
          description:
            '目标元素引用编号（来自 wb_browser_open / wb_browser_observe 返回的 "e1"、"e2" 等，优先推荐）',
        },
        selector: {
          type: 'string',
          description: '备选 CSS / Playwright 选择器（当未使用 ref 时使用）',
        },
        text: {
          type: 'string',
          description: 'fill / type / select / wait_for_text 所需的文本内容',
        },
        key: {
          type: 'string',
          description: 'press 动作的按键名称（如 "Enter"、"Tab"、"Escape"、"Control+Enter"）',
        },
        clearFirst: {
          type: 'boolean',
          description:
            'fill 富文本框或 type 时是否先全选清空原有内容（fill 默认 true，type 默认 false）',
        },
        scrollDeltaY: {
          type: 'number',
          minimum: -4000,
          maximum: 4000,
          description: 'scroll 动作向下滚动像素值（正数向下，负数向上，默认 650）',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'upload_files 动作的本地文件路径列表（须先在 wb_browser_open 的 approvedFiles 中声明）',
        },
        waitMs: {
          type: 'number',
          minimum: 0,
          maximum: 10000,
          description: '动作执行后等待页面稳定的毫秒数（默认 350ms）',
        },
        timeoutMs: {
          type: 'number',
          minimum: 1000,
          maximum: 30000,
          description: '查找元素与执行动作的超时毫秒数（默认 10000ms）',
        },
      },
      required: ['profileId', 'action'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const rawProfileId = typeof args.profileId === 'string' ? args.profileId.trim() : '';
      const rawAction = typeof args.action === 'string' ? args.action.trim() : '';
      const validActions = new Set([
        'click',
        'double_click',
        'fill',
        'type',
        'press',
        'select',
        'hover',
        'scroll',
        'upload_files',
        'wait_for_text',
        'bring_to_front',
      ]);
      if (!rawProfileId || !validActions.has(rawAction)) {
        return errorResult('INVALID_ARGS', `无效的 profileId 或 action "${rawAction}"`);
      }
      const profileId = await resolveProfileId(deps, rawProfileId);

      const res = await deps.agentBrowser.act({
        profileId,
        action: rawAction as Parameters<typeof deps.agentBrowser.act>[0]['action'],
        ref: typeof args.ref === 'string' ? args.ref : undefined,
        selector: typeof args.selector === 'string' ? args.selector : undefined,
        text: typeof args.text === 'string' ? args.text : undefined,
        key: typeof args.key === 'string' ? args.key : undefined,
        clearFirst: typeof args.clearFirst === 'boolean' ? args.clearFirst : undefined,
        scrollDeltaY: typeof args.scrollDeltaY === 'number' ? args.scrollDeltaY : undefined,
        waitMs: typeof args.waitMs === 'number' ? args.waitMs : undefined,
        files: Array.isArray(args.files)
          ? args.files.map((x) => String(x).trim()).filter(Boolean)
          : undefined,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      });

      return okResult({
        ok: true,
        ...res,
      });
    },
  };

  const wbBrowserScreenshot: McpToolDefinition = {
    name: 'wb_browser_screenshot',
    description:
      '对当前 AI 标签页截取压缩 JPEG 视觉画面（仅在 Canvas 画布应用如 Google Sheets 网格、复杂视觉布局或 DOM 观察不足以判断时按需调用，平时优先用 wb_browser_observe 节省 Token）。',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        profileId: {
          type: 'string',
          description: '浏览器 profileId',
        },
        fullPage: {
          type: 'boolean',
          description: '是否截取整页长图（默认 false 仅截当前视口）',
        },
        quality: {
          type: 'number',
          minimum: 30,
          maximum: 90,
          description: 'JPEG 压缩质量 30~90（默认 65）',
        },
      },
      required: ['profileId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const rawProfileId = typeof args.profileId === 'string' ? args.profileId.trim() : '';
      if (!rawProfileId) return errorResult('PROFILE_ID_REQUIRED', '必须提供 profileId');
      const profileId = await resolveProfileId(deps, rawProfileId);

      const shot = await deps.agentBrowser.screenshot({
        profileId,
        fullPage: args.fullPage === true,
        quality: typeof args.quality === 'number' ? args.quality : undefined,
      });

      const meta = {
        ok: true,
        profileId: shot.profileId,
        url: shot.url,
        title: shot.title,
        mimeType: shot.mimeType,
        byteLength: shot.byteLength,
      };

      return {
        content: [
          { type: 'text', text: JSON.stringify(meta, null, 2) },
          { type: 'image', data: shot.base64, mimeType: shot.mimeType },
        ],
        structuredContent: meta,
      };
    },
  };

  const wbBrowserClose: McpToolDefinition = {
    name: 'wb_browser_close',
    description:
      '关闭指定浏览器（或全部浏览器）上的 AI 临时标签页，释放内核占用并让浏览器恢复空闲就绪（PAUSED / synced: true），绝不影响用户自己打开的其他标签页。完成通用网页自动化任务后必须调用。',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: {
          type: 'string',
          description: '要关闭 AI 会话的浏览器 profileId',
        },
        all: {
          type: 'boolean',
          description: '传 true 则关闭当前全部活跃的 AI 浏览器会话',
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      if (args.all === true) {
        const before = deps.agentBrowser.listSessions().map((s) => s.profileId);
        await deps.agentBrowser.closeAll();
        return okResult({
          ok: true,
          closedProfileIds: before,
          remainingSessions: deps.agentBrowser.listSessions(),
        });
      }
      const rawProfileId = typeof args.profileId === 'string' ? args.profileId.trim() : '';
      if (!rawProfileId) {
        return errorResult('PROFILE_ID_REQUIRED', '请提供 profileId 或设置 all=true');
      }
      const directOpen = deps.agentBrowser
        .listSessions()
        .find((s) => s.profileId.toLowerCase() === rawProfileId.toLowerCase());
      const profileId = directOpen
        ? directOpen.profileId
        : await resolveProfileId(deps, rawProfileId);
      const res = await deps.agentBrowser.close(profileId);
      return okResult({
        ok: true,
        ...res,
        remainingSessions: deps.agentBrowser.listSessions(),
      });
    },
  };

  const wbBrowserLifecycle: McpToolDefinition = {
    name: 'wb_browser_lifecycle',
    description:
      '安全控制「已安装工作台插件并配对注册」的浏览器资料生命周期（启动 open / 安全关窗 close / 卡死自愈重开 restart / 查询启动能力 status）。严格仅管理已在工作台注册的浏览器，绝不扫描或暴露未装插件的本机浏览器资料；启动参数与正常打开完全一致（--profile-directory、--user-data-dir、--window-name，无任何自动化/调试标记）；关窗仅关闭指定资料窗口而不杀共享进程、不误关其他窗口。当某个浏览器页面卡死无响应时，调用 action="restart" 可安全停止该号任务并自动关窗重开自愈（保留 PENDING_REVIEW 待核对账本不重发）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'close', 'restart', 'status'],
          description:
            '生命周期动作：open（启动离线浏览器并等待插件就绪）、close（停止该号任务并安全关闭其窗口）、restart（卡死自愈：关闭后以正常参数重新打开并等待回连）、status（查询在线与可启动状态）',
        },
        profileId: {
          type: 'string',
          description: '单个目标浏览器标识（UUID、浏览器名如 "用户8" 或专页名）',
        },
        profileIds: {
          type: 'array',
          items: { type: 'string' },
          description: '多个目标浏览器标识列表（仅限已安装插件并注册的浏览器）',
        },
        timeoutMs: {
          type: 'number',
          minimum: 5000,
          maximum: 60000,
          description: '单浏览器启动或关窗等待超时毫秒数（默认启动 35000 / 关窗 15000）',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: async (args) => {
      if (!deps.profileLifecycle) {
        return errorResult('LIFECYCLE_UNAVAILABLE', '当前环境未启用浏览器生命周期管理器');
      }
      const action = String(args.action ?? '').trim();
      if (!['open', 'close', 'restart', 'status'].includes(action)) {
        return errorResult('INVALID_ACTION', 'action 必须为 open、close、restart 或 status');
      }
      const rawSingle = typeof args.profileId === 'string' ? args.profileId.trim() : '';
      const rawList = [
        ...(Array.isArray(args.profileIds)
          ? args.profileIds.map((x) => String(x).trim()).filter(Boolean)
          : []),
        ...(rawSingle ? [rawSingle] : []),
      ];
      if (rawList.length === 0) {
        return errorResult(
          'PROFILE_IDS_REQUIRED',
          '请通过 profileId 或 profileIds 指定已安装工作台插件的浏览器',
        );
      }

      const profileIds = await resolveProfileIds(deps, rawList);
      const timeoutMs =
        typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
          ? Math.max(5000, Math.min(60000, Math.floor(args.timeoutMs)))
          : undefined;

      if (action === 'status') {
        const items = await deps.profileLifecycle.getStatus(profileIds);
        return okResult({
          ok: items.every((item) => item.ok),
          action,
          count: items.length,
          items,
        });
      }

      if (action === 'open') {
        const res = await deps.profileLifecycle.ensureProfilesOnline(profileIds, { timeoutMs });
        return okResult({
          ok: res.failed.length === 0,
          action,
          ...res,
        });
      }

      const items = [];
      for (const id of profileIds) {
        if (action === 'close') {
          items.push(await deps.profileLifecycle.closeProfile(id, { timeoutMs }));
        } else {
          items.push(
            await deps.profileLifecycle.restartProfile(id, {
              closeTimeoutMs: 15_000,
              openTimeoutMs: timeoutMs,
            }),
          );
        }
      }

      return okResult({
        ok: items.every((item) => item.ok),
        action,
        succeededCount: items.filter((item) => item.ok).length,
        failedCount: items.filter((item) => !item.ok).length,
        items,
      });
    },
  };

  return [
    wbBrowserOpen,
    wbBrowserObserve,
    wbBrowserAct,
    wbBrowserScreenshot,
    wbBrowserClose,
    wbBrowserLifecycle,
  ];
}
