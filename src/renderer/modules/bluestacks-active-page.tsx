import { useMemo, useState } from 'react';
import {
  bluestacksDisplayTitle,
  type BluestacksQuickActiveStepType,
  type BluestacksState,
} from '../../shared/bluestacks.js';
import type { SavedCombination } from '../../shared/contracts.js';
import { isUserSavedCombination } from '../../shared/auto-scheduler.js';
import { api } from '../api.js';
import { ControlledNumberInput } from './shared/controlled-number-input.js';

const QUICK_ACTIONS: ReadonlyArray<{
  type: BluestacksQuickActiveStepType;
  title: string;
  desc: string;
  badge: string;
  hasDuration?: boolean;
  hasLikes?: boolean;
  hasAccepts?: boolean;
  hasComposer?: boolean;
}> = [
  {
    type: 'feed',
    title: '浏览首页 (Feed)',
    desc: '自然滑动动态流并按上限随机点赞互动，个人号与专页身份通用。',
    badge: '个人 / 专页',
    hasDuration: true,
    hasLikes: true,
  },
  {
    type: 'video',
    title: '浏览 Reels 短视频',
    desc: '进入 Reels 沉浸刷短视频，动态检测播放并按上限点赞，支持个人号与专页。',
    badge: '个人 / 专页',
    hasDuration: true,
    hasLikes: true,
  },
  {
    type: 'marketplace',
    title: '浏览商城 (Marketplace)',
    desc: '进入 Facebook Marketplace 浏览并查看商品详情；若为专页身份将自动安全跳过。',
    badge: '个人号专属',
    hasDuration: true,
  },
  {
    type: 'friends',
    title: '接受好友请求',
    desc: '自动识别并点击实心蓝色「确认」按钮通过好友申请；专页身份自动安全跳过。',
    badge: '个人号专属',
    hasDuration: true,
    hasAccepts: true,
  },
  {
    type: 'post',
    title: '发时间线贴文',
    desc: '在当前身份主页发布文字、彩底短贴、本地图片或视频（推送相册后自动清理）。',
    badge: '个人 / 专页',
    hasComposer: true,
  },
  {
    type: 'story',
    title: '发布快拍 (Story)',
    desc: '发布图片或视频快拍（支持自定义本地文件路径，自动推送相册并在发完后清理）。',
    badge: '个人 / 专页',
    hasComposer: true,
  },
];

export function BluestacksActivePage({
  bluestacksState,
  onBluestacksState,
  selected,
  combinations,
  onMessage,
}: {
  bluestacksState: BluestacksState | null;
  onBluestacksState: (next: BluestacksState) => void;
  selected: ReadonlySet<string>;
  combinations: readonly SavedCombination[];
  onMessage: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [stepType, setStepType] = useState<BluestacksQuickActiveStepType>('feed');
  const [durationMinutes, setDurationMinutes] = useState(3);
  const [maxLikes, setMaxLikes] = useState(2);
  const [maxAccepts, setMaxAccepts] = useState(3);
  const [caption, setCaption] = useState('');
  const [mediaPath, setMediaPath] = useState('');
  const [background, setBackground] = useState<'plain' | 'color'>('plain');

  const savedCombos = useMemo(() => combinations.filter(isUserSavedCombination), [combinations]);
  const instances = bluestacksState?.instances ?? [];
  const selectedIds = useMemo(() => [...selected], [selected]);
  const selectedInstances = useMemo(
    () => instances.filter((i) => selected.has(i.id)),
    [instances, selected],
  );
  const isRunning = Boolean(bluestacksState?.activeRunning);
  const activeDef = QUICK_ACTIONS.find((a) => a.type === stepType) ?? QUICK_ACTIONS[0];

  async function runCombination(combinationId: string, name: string) {
    if (selectedIds.length === 0) {
      onMessage('请先在左侧蓝蝶窗口列表中勾选至少一个模拟器');
      return;
    }
    setBusy(true);
    try {
      const next = await api.bluestacksAction('active/start', {
        instanceIds: selectedIds,
        combinationId,
      });
      onBluestacksState(next);
      onMessage(`已启动蓝蝶活跃组合「${name}」（${selectedIds.length} 台蓝蝶）`);
    } catch (err) {
      onMessage(err instanceof Error ? err.message : '启动蓝蝶活跃失败');
    } finally {
      setBusy(false);
    }
  }

  async function runQuickStep() {
    if (selectedIds.length === 0) {
      onMessage('请先在左侧蓝蝶窗口列表中勾选至少一个模拟器');
      return;
    }
    if (stepType === 'post' && !caption.trim() && !mediaPath.trim()) {
      onMessage('发贴文时请至少填写文案或本地媒体路径');
      return;
    }
    if (stepType === 'story' && !mediaPath.trim()) {
      onMessage('发快拍请填写本地图片或视频文件路径');
      return;
    }
    setBusy(true);
    try {
      const quickStep = {
        type: stepType,
        ...(activeDef?.hasDuration ? { durationMinutes } : {}),
        ...(activeDef?.hasLikes ? { maxLikes } : {}),
        ...(activeDef?.hasAccepts ? { maxAccepts } : {}),
        ...(activeDef?.hasComposer && caption.trim() ? { caption: caption.trim() } : {}),
        ...(activeDef?.hasComposer && mediaPath.trim() ? { mediaPath: mediaPath.trim() } : {}),
        ...(stepType === 'post' && !mediaPath.trim() ? { background } : {}),
      };
      const next = await api.bluestacksAction('active/start', {
        instanceIds: selectedIds,
        quickStep,
      });
      onBluestacksState(next);
      onMessage(`已启动蓝蝶「${activeDef?.title ?? stepType}」（${selectedIds.length} 台蓝蝶）`);
    } catch (err) {
      onMessage(err instanceof Error ? err.message : '启动蓝蝶快捷活跃失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setBusy(true);
    try {
      const next = await api.bluestacksAction('active/stop', {});
      onBluestacksState(next);
      onMessage('已发送停止蓝蝶活跃指令');
    } catch (err) {
      onMessage(err instanceof Error ? err.message : '停止失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="page"
      style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 20 }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>蓝蝶活跃账号</h2>
          <p className="hint" style={{ margin: '4px 0 0' }}>
            {bluestacksState?.activeStatusText ||
              '支持个人号与专页双身份运行；可直接复用已保存的任务组合，或下发单步快捷养号动作。'}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="pill">已选蓝蝶 {selectedIds.length} 台</span>
          {isRunning && (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={() => void handleStop()}
            >
              停止全部活跃
            </button>
          )}
        </div>
      </header>

      <section className="panel" style={{ padding: 16 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <strong>快捷单步动作</strong>
          <span className="hint">按当前勾选的蓝蝶窗口并发执行</span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 10,
            marginBottom: 16,
          }}
        >
          {QUICK_ACTIONS.map((item) => {
            const active = stepType === item.type;
            return (
              <button
                key={item.type}
                type="button"
                onClick={() => setStepType(item.type)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'stretch',
                  justifyContent: 'flex-start',
                  height: 'auto',
                  minHeight: 74,
                  whiteSpace: 'normal',
                  textAlign: 'left',
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: active ? '1.5px solid var(--accent)' : '1px solid var(--line)',
                  background: active
                    ? 'var(--accent-soft, rgba(59,130,246,0.08))'
                    : 'var(--bg-card, var(--surface))',
                  cursor: 'pointer',
                  gap: 6,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 6,
                    width: '100%',
                  }}
                >
                  <strong style={{ fontSize: 13, lineHeight: 1.3 }}>{item.title}</strong>
                  <span className="pill" style={{ fontSize: 11, flexShrink: 0 }}>
                    {item.badge}
                  </span>
                </div>
                <div
                  className="hint"
                  style={{
                    fontSize: 12,
                    lineHeight: 1.45,
                    whiteSpace: 'normal',
                    wordBreak: 'break-word',
                  }}
                >
                  {item.desc}
                </div>
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          {activeDef?.hasDuration && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span>持续时长（分钟）</span>
              <ControlledNumberInput
                ariaLabel="持续时长"
                min={1}
                max={60}
                defaultValue={3}
                value={durationMinutes}
                onChange={setDurationMinutes}
              />
            </label>
          )}
          {activeDef?.hasLikes && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span>最多点赞次数</span>
              <ControlledNumberInput
                ariaLabel="最多点赞次数"
                min={0}
                max={50}
                defaultValue={2}
                value={maxLikes}
                onChange={setMaxLikes}
              />
            </label>
          )}
          {activeDef?.hasAccepts && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span>最多通过人数</span>
              <ControlledNumberInput
                ariaLabel="最多通过人数"
                min={1}
                max={50}
                defaultValue={3}
                value={maxAccepts}
                onChange={setMaxAccepts}
              />
            </label>
          )}
          {activeDef?.hasComposer && (
            <>
              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  fontSize: 12,
                  flex: '1 1 240px',
                }}
              >
                <span>{stepType === 'story' ? '配文（可选）' : '贴文文案'}</span>
                <input
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  placeholder="输入要发布的内容文案"
                />
              </label>
              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  fontSize: 12,
                  flex: '1 1 240px',
                }}
              >
                <span>本地图片 / 视频绝对路径{stepType === 'story' ? '（必填）' : '（可选）'}</span>
                <input
                  value={mediaPath}
                  onChange={(e) => setMediaPath(e.target.value)}
                  placeholder="例如：D:\Media\photo.jpg"
                />
              </label>
              {stepType === 'post' && !mediaPath.trim() && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                  <span>纯文字样式</span>
                  <select
                    value={background}
                    onChange={(e) => setBackground(e.target.value === 'color' ? 'color' : 'plain')}
                  >
                    <option value="plain">普通白底</option>
                    <option value="color">随机彩色背景</option>
                  </select>
                </label>
              )}
            </>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || selectedIds.length === 0}
            onClick={() => void runQuickStep()}
          >
            {busy ? '启动中…' : `开始执行：${activeDef?.title ?? ''}`}
          </button>
        </div>
      </section>

      <section className="panel" style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
          <strong>复用已保存的任务组合（{savedCombos.length}）</strong>
          <span className="hint">
            自动将组合内的刷首页 / Reels / 商城 / 好友 / 发帖步骤映射到 FB Lite
          </span>
        </div>
        {savedCombos.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            暂无已保存的任务组合，可先在「活跃账号」模块新建组合，或直接使用上方快捷动作。
          </p>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: 10,
            }}
          >
            {savedCombos.map((combo) => {
              const spec = combo.saved;
              if (!spec) return null;
              return (
                <div
                  key={combo.id}
                  style={{
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    padding: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <strong style={{ fontSize: 14 }}>{spec.name}</strong>
                  <span className="hint" style={{ fontSize: 12 }}>
                    共 {spec.steps.length} 个步骤
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={busy || selectedIds.length === 0}
                    onClick={() => void runCombination(combo.id, spec.name)}
                  >
                    在已选蓝蝶执行
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {selectedInstances.length > 0 && (
        <section className="panel" style={{ padding: 16 }}>
          <strong style={{ display: 'block', marginBottom: 10 }}>
            已选蓝蝶实时状态（{selectedInstances.length}）
          </strong>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {selectedInstances.map((inst) => {
              const stat = bluestacksState?.activeProfileCounts?.[inst.id];
              return (
                <div
                  key={inst.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 10px',
                    borderRadius: 6,
                    background: 'var(--bg-subtle, rgba(0,0,0,0.03))',
                    fontSize: 13,
                  }}
                >
                  <span>
                    <strong>{bluestacksDisplayTitle(inst)}</strong>
                    {inst.accountName ? ` · ${inst.accountName}` : ''}
                    {inst.identityType === 'page'
                      ? ' [专页]'
                      : inst.identityType === 'personal'
                        ? ' [个人]'
                        : ''}
                  </span>
                  <span className="hint">
                    {stat?.status || (inst.online ? '在线就绪' : '未启动（运行自动拉起）')}
                    {stat && stat.session > 0 ? ` · 本轮互动 ${stat.session}` : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
