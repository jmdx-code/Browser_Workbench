import * as M from './mcp-context.js';

const BROWSER_ACTIONS =
  'click double_click fill type press select hover scroll upload_files wait_for_text bring_to_front';
const LIFECYCLE_ACTIONS =
  'open close restart status cleanup_tabs show_window arrange_windows restore_windows';
const BROWSER_ACT_SET = new Set(BROWSER_ACTIONS.split(' '));
const LIFECYCLE_ACT_SET = new Set(LIFECYCLE_ACTIONS.split(' '));

async function handleLifecycle(deps: M.WorkbenchMcpDependencies, args: Record<string, unknown>) {
  const action = M.strArg(args.action);
  const rawList = M.collectRawIds(args, 'profileIds', 'profileId');
  M.req(LIFECYCLE_ACT_SET.has(action), 'INVALID_ACTION', '无效的 lifecycle action');
  if (action === 'cleanup_tabs') {
    M.req(
      deps.browserWindow?.cleanupTabs,
      'BROWSER_WINDOW_UNAVAILABLE',
      '当前环境未启用标签整理服务',
      503,
    );
    const pids =
      rawList.length > 0
        ? await M.resolveProfileIds(deps, rawList)
        : (await M.buildEnrichedProfiles(deps)).filter((p) => p.online).map((p) => p.id);
    return {
      action,
      ...(pids.length === 0
        ? { cleanedProfiles: 0, closedTabs: 0, skippedBusy: 0, skippedOffline: 0 }
        : await deps.browserWindow.cleanupTabs(pids, args.preferActiveTab === true)),
    };
  }
  if (action === 'show_window') {
    M.req(deps.browserWindow, 'BROWSER_WINDOW_UNAVAILABLE', '当前环境未启用窗口显示服务', 503);
    M.req(rawList.length > 0, 'PROFILE_IDS_REQUIRED', 'show_window 需要指定 profileId');
    const [pids, aliasMap] = await Promise.all([
      M.resolveProfileIds(deps, rawList),
      M.buildProfileDisplayNameMap(deps),
    ]);
    const items = [];
    for (const id of pids) items.push(await deps.browserWindow.show(id, aliasMap.get(id) ?? id));
    return { action, count: items.length, items };
  }
  if (action === 'arrange_windows' || action === 'restore_windows') {
    M.req(deps.windowLayout, 'WINDOW_LAYOUT_UNAVAILABLE', '当前环境未启用窗口布局服务', 503);
    const pids = rawList.length > 0 ? await M.resolveProfileIds(deps, rawList) : undefined;
    return {
      action,
      layout: await deps.windowLayout.command({
        action: action === 'arrange_windows' ? 'apply' : 'restore',
        ...(pids?.length && { profileIds: pids }),
      }),
    };
  }
  M.req(deps.profileLifecycle, 'LIFECYCLE_UNAVAILABLE', '当前环境未启用浏览器生命周期管理器', 503);
  M.req(rawList.length > 0, 'PROFILE_IDS_REQUIRED', '请通过 profileId 或 profileIds 指定浏览器');
  const pids = await M.resolveProfileIds(deps, rawList);
  const timeoutMs =
    typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
      ? M.clampInt(args.timeoutMs, 35000, 5000, 60000)
      : undefined;
  if (action === 'status') {
    const items = await deps.profileLifecycle.getStatus(pids);
    return { ok: items.every((i) => i.ok), action, count: items.length, items };
  }
  if (action === 'open') {
    const res = await deps.profileLifecycle.ensureProfilesOnline(pids, { timeoutMs });
    return { ok: res.failed.length === 0, action, ...res };
  }
  const items = [];
  for (const id of pids)
    items.push(
      action === 'close'
        ? await deps.profileLifecycle.closeProfile(id, { timeoutMs })
        : await deps.profileLifecycle.restartProfile(id, {
            closeTimeoutMs: 15_000,
            openTimeoutMs: timeoutMs,
          }),
    );
  return {
    ok: items.every((i) => i.ok),
    action,
    succeededCount: items.filter((i) => i.ok).length,
    failedCount: items.filter((i) => !i.ok).length,
    items,
  };
}

export function createAgentBrowserTools(deps: M.WorkbenchMcpDependencies): M.McpToolDefinition[] {
  return [
    M.reg(
      'wb_browser_open',
      '在指定真实浏览器打开或跳转 AI 临时标签页。',
      M.sp(
        '@profileId|url:s:完整http/https网址|foreground:b:置顶窗口|reuseSession:b:复用AI标签页|approvedFiles:sa:允许上传文件|browseSeconds:n(1,600):拟人浏览秒数|timeoutMs:n(3000,60000):导航超时',
      ),
      async (args) => {
        const url = M.strArg(args.url);
        M.req(url, 'INVALID_ARGS', 'profileId 与 url 均为必填项');
        const profileId = await M.reqSinglePid(deps, args);
        const peer = deps.core.peers.get(profileId);
        if (!(peer?.online && (peer.browserWindowCount ?? 1) > 0) && deps.profileLifecycle) {
          const ensured = await deps.profileLifecycle.ensureProfilesOnline([profileId], {
            timeoutMs: 35_000,
          });
          if (!ensured.readyIds.includes(profileId))
            return M.errorResult(
              ensured.failed[0]?.errorCode ?? 'BROWSER_OFFLINE',
              ensured.failed[0]?.reason ?? '自动启动浏览器未成功',
            );
        }
        const files = M.strArrArg(args.approvedFiles);
        return deps.agentBrowser.open({
          profileId,
          url,
          foreground: args.foreground === true,
          reuseSession: args.reuseSession !== false,
          ...(files.length > 0 && { approvedFiles: files }),
          ...M.pickTypes(args, 'browseSeconds:n timeoutMs:n'),
        });
      },
      { req: 'profileId url', openWorld: true },
    ),
    M.reg(
      'wb_browser_observe',
      '读取 AI 标签页 DOM 结构、可交互元素与人机验证状态。',
      M.sp(
        '@profileId|maxElements:n(5,200):最大交互元素数|includeTextChars:n(200,16000):最大文本字数|selectorScope:s:限定容器选择器',
      ),
      async (args) => {
        const profileId = await M.reqSinglePid(deps, args);
        return {
          profileId,
          observation: await deps.agentBrowser.observe({
            profileId,
            ...M.pickTypes(args, 'maxElements:n includeTextChars:n selectorScope:rs'),
          }),
        };
      },
      { req: 'profileId', readOnly: true, openWorld: true },
    ),
    M.reg(
      'wb_browser_act',
      '在 AI 标签页执行单步交互操作。',
      M.sp(
        `@profileId|action:e(${BROWSER_ACTIONS}):交互动作|ref:s:元素引用编号|selector:s:选择器|text:s:输入/选择/等待文本|key:s:按键名|clearFirst:b:先清空内容|scrollDeltaY:n(-4000,4000):滚动像素值|files:sa:上传文件路径|waitMs:n(0,10000):动作后等待|timeoutMs:n(1000,30000):超时毫秒数`,
      ),
      async (args) => {
        const act = M.strArg(args.action);
        M.req(BROWSER_ACT_SET.has(act), 'INVALID_ARGS', `无效的 action "${act}"`);
        const profileId = await M.reqSinglePid(deps, args);
        return deps.agentBrowser.act({
          profileId,
          action: act as Parameters<typeof deps.agentBrowser.act>[0]['action'],
          ...M.pickTypes(
            args,
            'ref:rs selector:rs text:rs key:rs clearFirst:b scrollDeltaY:n waitMs:n timeoutMs:n',
          ),
          ...(Array.isArray(args.files) && { files: M.strArrArg(args.files) }),
        });
      },
      { req: 'profileId action', openWorld: true },
    ),
    M.reg(
      'wb_browser_screenshot',
      '截取当前 AI 标签页 JPEG 画面。',
      M.sp('@profileId|fullPage:b:整页截图|quality:n(30,90):JPEG质量'),
      async (args) => {
        const profileId = await M.reqSinglePid(deps, args);
        const shot = await deps.agentBrowser.screenshot({
          profileId,
          fullPage: args.fullPage === true,
          ...M.pickTypes(args, 'quality:n'),
        });
        const meta = { ok: true, ...M.pick(shot, 'profileId url title mimeType byteLength') };
        return {
          content: [
            { type: 'text', text: JSON.stringify(meta, null, 2) },
            { type: 'image', data: shot.base64, mimeType: shot.mimeType },
          ],
          structuredContent: meta,
        };
      },
      { req: 'profileId', readOnly: true, openWorld: true },
    ),
    M.reg(
      'wb_browser_close',
      '关闭指定或全部 AI 浏览器会话。',
      M.sp('@profileId|all:b:关闭全部会话'),
      async (args) => {
        if (args.all === true) {
          const closedProfileIds = deps.agentBrowser.listSessions().map((s) => s.profileId);
          await deps.agentBrowser.closeAll();
          return { closedProfileIds, remainingSessions: deps.agentBrowser.listSessions() };
        }
        const raw = M.strArg(args.profileId);
        M.req(raw, 'PROFILE_ID_REQUIRED', '请提供 profileId 或设置 all=true');
        const direct = deps.agentBrowser
          .listSessions()
          .find((s) => s.profileId.toLowerCase() === raw.toLowerCase());
        const res = await deps.agentBrowser.close(
          direct ? direct.profileId : await M.resolveProfileId(deps, raw),
        );
        return { ...res, remainingSessions: deps.agentBrowser.listSessions() };
      },
    ),
    M.reg(
      'wb_browser_lifecycle',
      '控制浏览器生命周期与窗口布局。',
      M.sp(
        `@profileId|@profileIds|action:e(${LIFECYCLE_ACTIONS}):生命周期动作|preferActiveTab:b:保留当前活动标签|timeoutMs:n(5000,60000):等待超时`,
      ),
      (args) => handleLifecycle(deps, args),
      { req: 'action' },
    ),
  ];
}
