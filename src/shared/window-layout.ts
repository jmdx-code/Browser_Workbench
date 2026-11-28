import { z } from 'zod';
import { Id, NonNegInt, intRange, sMax, sReq, strictObj } from './contracts.js';
import { OwnedTabProof } from './kernel-state.js';
const xy = intRange(-100000, 100000),
  wh = intRange(100, 20000),
  dispId = sMax(80);
export const WindowRect = strictObj({ x: xy, y: xy, width: wh, height: wh });
export const LayoutDisplay = strictObj({
  id: dispId,
  primary: z.boolean(),
  scaleFactor: z.number().positive(),
  workArea: WindowRect,
});
export type LayoutDisplayValue = z.infer<typeof LayoutDisplay>;
export const LayoutDisplays = z.array(LayoutDisplay).max(32);
export const TileDisplayConfig = strictObj({
  displayId: dispId,
  enabled: z.boolean(),
  rows: intRange(0, 8),
  cols: intRange(0, 8),
  startSlot: intRange(1, 64),
});
const sharedLayoutFields = {
  tileDisplays: z.array(TileDisplayConfig).max(16).optional(),
  tileGap: intRange(0, 48).optional(),
  tileOverflow: z.enum(['wrap', 'keep']).optional(),
  cascadeWidth: intRange(480, 3840).optional(),
  cascadeHeight: intRange(360, 2160).optional(),
  cascadeStepX: intRange(8, 200).optional(),
  cascadeStepY: intRange(8, 200).optional(),
  cascadeStartX: intRange(0, 2000).optional(),
  cascadeStartY: intRange(0, 2000).optional(),
};
export const WindowLayoutPreset = strictObj({
  id: sReq(64),
  name: sReq(40),
  mode: z.enum(['cascade', 'tile']),
  ...sharedLayoutFields,
  displayId: dispId.nullable().optional(),
});
export const WindowLayoutSettings = strictObj({
  version: z.literal(1),
  enabled: z.boolean(),
  displayId: dispId.nullable(),
  step: intRange(4, 32),
  reservedArea: WindowRect.optional(),
  mode: z.enum(['cascade', 'tile']).optional(),
  ...sharedLayoutFields,
  applyScope: z.enum(['selected', 'all_online']).optional(),
  applySort: z.enum(['list', 'name']).optional(),
  presets: z.array(WindowLayoutPreset).max(8).optional(),
});
export const defaultWindowLayout = {
  version: 1 as const,
  enabled: false,
  displayId: null,
  step: 8,
};
const insetBound = intRange(0, 20000);
export const TaskWindowSnapshot = strictObj({
  proof: OwnedTabProof,
  windowId: z.number().int(),
  state: z.enum(['normal', 'minimized', 'maximized', 'fullscreen', 'locked-fullscreen']),
  rect: WindowRect,
  contentInsets: strictObj({
    left: insetBound,
    top: insetBound,
    right: insetBound,
    bottom: insetBound,
  }).optional(),
});
export const WindowLayoutCommand = strictObj({
  action: z.enum(['configure', 'apply', 'restore', 'focus_all']),
  settings: WindowLayoutSettings.optional(),
  profileIds: z.array(Id).min(1).max(100).optional(),
  mode: z.enum(['cascade', 'tile']).optional(),
  targetDisplayId: dispId.optional(),
});
export type TileDisplayConfig = z.infer<typeof TileDisplayConfig>;
export type WindowLayoutPreset = z.infer<typeof WindowLayoutPreset>;
export type LayoutSettings = z.infer<typeof WindowLayoutSettings>;
export type LayoutScreen = z.infer<typeof LayoutDisplay>;
export type Rect = z.infer<typeof WindowRect>;
export type TaskWindow = z.infer<typeof TaskWindowSnapshot>;
export interface TaskWindowPort {
  read(profileId: string): Promise<TaskWindow>;
  move(
    profileId: string,
    expected: TaskWindow,
    rect: Rect,
    exposed: boolean,
    deadline?: number,
    focus?: boolean,
  ): Promise<TaskWindow>;
}
export interface WindowLayoutPort {
  snapshot(): Promise<unknown>;
  command(input: unknown): Promise<unknown>;
}
export const WindowLayoutOverview = strictObj({
  settings: WindowLayoutSettings,
  displays: LayoutDisplays,
  managed: z.array(strictObj({ profileId: Id, rect: WindowRect })).max(100),
  error: z.string(),
  movedCount: NonNegInt.optional(),
  failedProfiles: z.array(Id).max(100).optional(),
  recovery: z
    .array(
      strictObj({
        profileId: Id,
        state: z.enum(['AWAITING_VISIBILITY', 'NEEDS_ATTENTION']),
        moves: NonNegInt,
        reason: z.string(),
      }),
    )
    .max(100)
    .optional(),
});
const WINDOW_LAYOUT_MESSAGES = Object.fromEntries(
  `WINDOW_LAYOUT_RECOVERY_EXHAUSTED=已尝试露边恢复，任务页仍被遮挡。请露出部分网页，或使用“显示浏览器”；页面恢复可见后继续。
WINDOW_LAYOUT_RESERVED_AREA_INVALID=保留区域已超出所选屏幕，请重新设置区域或选择整个可用屏幕。
WINDOW_LAYOUT_CONTENT_BOUNDS_REQUIRED=尚未取得可靠的网页尺寸，请刷新新版扩展和任务页后重新整理。
WINDOW_LAYOUT_CONTENT_CHANGED=网页可用尺寸已变化，请检查工具栏或侧栏后重新整理。
WINDOW_LAYOUT_PLACEMENT_UNCONFIRMED=已尝试的错位位置不能同时保证各浏览器露出网页内容。请重新整理或调整保留区域；这不表示其他窗口占用的区域禁止重叠。
WINDOW_LAYOUT_CAPACITY_EXCEEDED=所选区域过小，请扩大活动区域或更换屏幕。
WINDOW_LAYOUT_DISPLAY_MISSING=所选屏幕未连接，请重新选择屏幕。
WINDOW_LAYOUT_DISPLAY_CHANGED=屏幕尺寸或缩放已变化，请重新读取后整理。
WINDOW_LAYOUT_EXTENSION_UPDATE_REQUIRED=参与布局的浏览器需要刷新到新版桥接扩展。
WINDOW_LAYOUT_NORMAL_WINDOW_REQUIRED=请先将任务浏览器从最大化、最小化或全屏还原为普通窗口，再整理。
WINDOW_LAYOUT_PROFILE_OFFLINE=有浏览器尚未连接并同步，请检查连接。
WINDOW_LAYOUT_USER_CHANGED=这是旧版的位置检查记录。新版直接使用当前位置，停止旧任务后重新启动即可，无需恢复位置或重启软件。
WINDOW_LAYOUT_MAIN_CHANGED=任务主页已变化，请在工作台显示并核对该浏览器的主页后重试。
WINDOW_LAYOUT_UNAVAILABLE=当前环境未启用窗口布局服务（请在桌面端使用）。
WINDOW_LAYOUT_SELECTION_REQUIRED=请先选择至少一个在线浏览器窗口再执行排版。
WINDOW_LAYOUT_SETTINGS_REQUIRED=缺少窗口排版配置内容，请重试。
WINDOW_LAYOUT_NO_WINDOW_MOVED=未能移动任何在线浏览器窗口，请检查扩展连接或恢复普通窗口状态后重试。`
    .split('\n')
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);
export function windowLayoutMessage(code: string): string {
  if (code.startsWith('WINDOW_LAYOUT_RESTORE_SKIPPED:'))
    return '部分窗口已离线、手动移动或更换主页，未覆盖这些窗口的位置；自动布局已关闭。';
  if (code.startsWith('WINDOW_LAYOUT_PARTIAL_ROLLBACK:'))
    return '整理未完成，部分窗口回退位置未确认。请检查窗口后重新读取，不会自动重试。';
  return WINDOW_LAYOUT_MESSAGES[code] ?? '窗口布局未确认：' + code;
}
