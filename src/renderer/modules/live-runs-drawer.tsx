import { IconActivity, IconCheckCircle, IconCircle, IconStop, IconWindow } from '../icons.js';
import { EmptyState, SlideDrawer } from '../ui/primitives.js';
import type { LiveRunCard } from './live-run-cards.js';
import { Btn } from './shared/module-ui.js';

export { buildLiveRunCards, type LiveRunCard, type LiveRunStepItem } from './live-run-cards.js';

export function LiveRunsDrawer(p: {
  open: boolean;
  onClose: () => void;
  cards: readonly LiveRunCard[];
  busy: boolean;
  onShowBrowser: (profileId: string) => void;
  onShowBluestacks?: ((instanceId: string) => void) | undefined;
  onStopCard: (card: LiveRunCard) => void;
  onStopAll: () => void;
}) {
  return (
    <SlideDrawer
      open={p.open}
      onClose={p.onClose}
      title="实时任务队列"
      subtitle={
        p.cards.length > 0
          ? `共 ${p.cards.length} 个账号/窗口正在执行或排队（全软件唯一实时进度视图）`
          : '当前没有正在运行的任务'
      }
      headerActions={
        p.cards.length > 0 ? (
          <Btn v="danger" disabled={p.busy} onClick={p.onStopAll}>
            <IconStop size={12} /> 全部停止
          </Btn>
        ) : undefined
      }
    >
      {p.cards.length === 0 ? (
        <EmptyState
          icon={<IconActivity size={28} />}
          title="当前没有正在执行的任务"
          description="从工作台或定时排班启动任务后，这里会集中展示每个账号的完整步骤待办清单。"
        />
      ) : (
        <div className="flex flex-col gap-3">
          {p.cards.map((card) => (
            <article
              key={card.key}
              className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-5 items-center rounded bg-slate-100 px-1.5 text-[11px] font-medium text-slate-600">
                      {card.carrier === 'browser' ? '浏览器' : '蓝蝶'}
                    </span>
                    <strong className="truncate text-[13.5px] font-semibold text-slate-900">
                      {card.targetName}
                    </strong>
                    <span className="inline-flex h-5 items-center rounded-full bg-blue-50 px-2 text-[11px] font-medium text-blue-700">
                      {card.statusText}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {card.title} · {card.subtitle}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {(card.carrier === 'browser' || p.onShowBluestacks) && (
                    <Btn
                      title={
                        card.carrier === 'browser'
                          ? '在桌面前置定位显示该浏览器窗口'
                          : '在桌面前置定位显示该蓝蝶窗口'
                      }
                      onClick={() =>
                        card.carrier === 'browser'
                          ? p.onShowBrowser(card.targetId)
                          : p.onShowBluestacks?.(card.targetId)
                      }
                    >
                      <IconWindow size={12} /> 显示窗口
                    </Btn>
                  )}
                  <Btn v="danger" disabled={p.busy} onClick={() => p.onStopCard(card)}>
                    <IconStop size={12} /> 停止
                  </Btn>
                </div>
              </div>
              <ol className="mt-3 flex flex-col gap-1.5 border-t border-slate-100 pt-2.5">
                {card.steps.map((step, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex min-w-0 items-center gap-2">
                      {step.state === 'done' ? (
                        <IconCheckCircle size={13} className="shrink-0 text-emerald-600" />
                      ) : step.state === 'running' ? (
                        <IconActivity size={13} className="shrink-0 text-blue-600" />
                      ) : (
                        <IconCircle size={13} className="shrink-0 text-slate-300" />
                      )}
                      <span
                        className={`truncate ${
                          step.state === 'done'
                            ? 'text-slate-400 line-through'
                            : step.state === 'running'
                              ? 'font-medium text-slate-900'
                              : 'text-slate-500'
                        }`}
                      >
                        {i + 1}. {step.label}
                      </span>
                    </span>
                    {step.meta && (
                      <span className="shrink-0 text-[11px] text-slate-500">{step.meta}</span>
                    )}
                  </li>
                ))}
                {card.closeOnFinish && (
                  <li className="flex items-center gap-2 text-[11px] text-slate-400">
                    <IconCircle size={12} className="shrink-0 text-slate-300" />
                    <span>全部步骤完成后自动关窗</span>
                  </li>
                )}
              </ol>
            </article>
          ))}
        </div>
      )}
    </SlideDrawer>
  );
}
