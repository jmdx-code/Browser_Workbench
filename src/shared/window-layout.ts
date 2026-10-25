import { z } from 'zod';
import { OwnedTabProof } from './kernel-state.js';

export const WindowRect = z
  .object({
    x: z.number().int().min(-100000).max(100000),
    y: z.number().int().min(-100000).max(100000),
    width: z.number().int().min(100).max(20000),
    height: z.number().int().min(100).max(20000),
  })
  .strict();
export const LayoutDisplay = z
  .object({
    id: z.string().max(80),
    primary: z.boolean(),
    scaleFactor: z.number().positive(),
    workArea: WindowRect,
  })
  .strict();
export const LayoutDisplays = z.array(LayoutDisplay).max(32);
export const WindowLayoutSettings = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    displayId: z.string().max(80).nullable(),
    step: z.number().int().min(4).max(32),
    // Additive preference: old saved settings continue to use the whole work area.
    reservedArea: WindowRect.optional(),
  })
  .strict();
export const defaultWindowLayout = {
  version: 1 as const,
  enabled: false,
  displayId: null,
  step: 8,
};
export const TaskWindowSnapshot = z
  .object({
    proof: OwnedTabProof,
    windowId: z.number().int(),
    state: z.enum(['normal', 'minimized', 'maximized', 'fullscreen', 'locked-fullscreen']),
    rect: WindowRect,
    contentInsets: z
      .object({
        left: z.number().int().nonnegative().max(20000),
        top: z.number().int().nonnegative().max(20000),
        right: z.number().int().nonnegative().max(20000),
        bottom: z.number().int().nonnegative().max(20000),
      })
      .strict()
      .optional(),
  })
  .strict();
export const WindowLayoutCommand = z
  .object({
    action: z.enum(['configure', 'apply', 'restore']),
    settings: WindowLayoutSettings.optional(),
    profileIds: z.array(z.uuid()).min(1).max(100).optional(),
  })
  .strict();
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
export const WindowLayoutOverview = z
  .object({
    settings: WindowLayoutSettings,
    displays: LayoutDisplays,
    managed: z.array(z.object({ profileId: z.uuid(), rect: WindowRect }).strict()).max(100),
    error: z.string(),
    recovery: z
      .array(
        z
          .object({
            profileId: z.uuid(),
            state: z.enum(['AWAITING_VISIBILITY', 'NEEDS_ATTENTION']),
            moves: z.number().int().nonnegative(),
            reason: z.string(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();
export function windowLayoutMessage(code: string): string {
  const messages: Record<string, string> = {
    WINDOW_LAYOUT_RECOVERY_EXHAUSTED:
      '已尝试露边恢复，任务页仍被遮挡。请露出部分网页，或使用“显示浏览器”；页面恢复可见后继续。',
    WINDOW_LAYOUT_RESERVED_AREA_INVALID:
      '保留区域已超出所选屏幕，请重新设置区域或选择整个可用屏幕。',
    WINDOW_LAYOUT_CONTENT_BOUNDS_REQUIRED:
      '尚未取得可靠的网页尺寸，请刷新新版扩展和任务页后重新整理。',
    WINDOW_LAYOUT_CONTENT_CHANGED: '网页可用尺寸已变化，请检查工具栏或侧栏后重新整理。',
    WINDOW_LAYOUT_PLACEMENT_UNCONFIRMED:
      '已尝试的错位位置不能同时保证各浏览器露出网页内容。请重新整理或调整保留区域；这不表示其他窗口占用的区域禁止重叠。',
    WINDOW_LAYOUT_CAPACITY_EXCEEDED: '所选区域过小，请扩大活动区域或更换屏幕。',
    WINDOW_LAYOUT_DISPLAY_MISSING: '所选屏幕未连接，请重新选择屏幕。',
    WINDOW_LAYOUT_DISPLAY_CHANGED: '屏幕尺寸或缩放已变化，请重新读取后整理。',
    WINDOW_LAYOUT_EXTENSION_UPDATE_REQUIRED: '参与布局的浏览器需要刷新到新版桥接扩展。',
    WINDOW_LAYOUT_NORMAL_WINDOW_REQUIRED:
      '请先将任务浏览器从最大化、最小化或全屏还原为普通窗口，再整理。',
    WINDOW_LAYOUT_PROFILE_OFFLINE: '有浏览器尚未连接并同步，请检查连接。',
    WINDOW_LAYOUT_USER_CHANGED:
      '这是旧版的位置检查记录。新版直接使用当前位置，停止旧任务后重新启动即可，无需恢复位置或重启软件。',
    WINDOW_LAYOUT_MAIN_CHANGED: '任务主页已变化，请在工作台显示并核对该浏览器的主页后重试。',
  };
  if (code.startsWith('WINDOW_LAYOUT_RESTORE_SKIPPED:'))
    return '部分窗口已离线、手动移动或更换主页，未覆盖这些窗口的位置；自动布局已关闭。';
  if (code.startsWith('WINDOW_LAYOUT_PARTIAL_ROLLBACK:'))
    return '整理未完成，部分窗口回退位置未确认。请检查窗口后重新读取，不会自动重试。';
  return messages[code] ?? '窗口布局未确认：' + code;
}
