import type { SavedCombination } from '../shared/contracts.js';
import {
  asIds,
  describeStepDrawer,
  isUnsupportedOnBluestacks,
  moveItem,
  type AnyStep,
  type StepMetaItem,
} from './auto-scheduler-step-helpers.js';
import { IconSliders } from './icons.js';
import { ControlledNumberInput } from './modules/shared/controlled-number-input.js';
import { Btn, Chk } from './modules/shared/module-ui.js';
import {
  BumperSettingsFields,
  summarizeBumperSettings,
} from './modules/shared/step-settings-fields.js';
import {
  UnifiedTargetPicker,
  type UnifiedPickerItem,
} from './modules/shared/unified-target-picker.js';
import { UI_INPUT_SM, UI_SELECT_SM, UiSwitch } from './ui/primitives.js';

export interface StepCardCtx {
  saving: boolean;
  stepMeta: readonly StepMetaItem[];
  savedCombos: readonly SavedCombination[];
  pageTargetItems: readonly UnifiedPickerItem[];
  groupTargetItems: readonly UnifiedPickerItem[];
  inviterGroupTargetItems: readonly UnifiedPickerItem[];
  posterMaterialItems: readonly UnifiedPickerItem[];
  makeStep: (type: AnyStep['type']) => AnyStep;
  updateStep: (index: number, next: AnyStep) => void;
  setSteps: (updater: (prev: AnyStep[]) => AnyStep[]) => void;
  setExpandedStepId: (id: string | null) => void;
  setParamOpenStepId: (id: string | null) => void;
}

const TARGET_BTN =
  'inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2.5 text-xs font-medium transition-colors';

function SchedNum(p: {
  aria: string;
  val: number;
  min: number;
  max: number;
  unit: string;
  onChange: (n: number) => void;
}) {
  return (
    <>
      <ControlledNumberInput
        ariaLabel={p.aria}
        className={`${UI_INPUT_SM} w-[60px] px-1.5 text-center`}
        debounceMs={0}
        value={p.val}
        defaultValue={p.val}
        min={p.min}
        max={p.max}
        onChange={p.onChange}
      />
      <span className="text-xs text-[var(--text-3)]">{p.unit}</span>
    </>
  );
}

export function AutoSchedulerStepCard({
  step,
  idx,
  totalSteps,
  isOpen,
  isParamOpen,
  ctx,
}: {
  step: AnyStep;
  idx: number;
  totalSteps: number;
  isOpen: boolean;
  isParamOpen: boolean;
  ctx: StepCardCtx;
}) {
  const drawer = describeStepDrawer(step, {
    pages: ctx.pageTargetItems.length,
    groups: ctx.groupTargetItems.length,
    inviterGroups: ctx.inviterGroupTargetItems.length,
  });
  const isBsCombo = step.type === 'bluestacks-active-combination';
  const isPageBumper = step.type === 'page-bumper' || step.type === 'bluestacks-page-bumper';
  const isBsBumper =
    step.type === 'bluestacks-group-bumper' || step.type === 'bluestacks-page-bumper';
  const isBumper = step.type === 'group-bumper' || step.type === 'page-bumper' || isBsBumper;
  const selectMeta =
    step.type === 'quick-browse' || step.type === 'bluestacks-quick-browse'
      ? [...ctx.stepMeta, { type: step.type, label: '快捷浏览（旧版）' }]
      : ctx.stepMeta;
  const bumperSummary = isBumper
    ? summarizeBumperSettings(step.settingsOverride, {
        pageMode: isPageBumper,
        bluestacks: isBsBumper,
      })
    : '';

  const renderPickers = () => {
    type Pk = [
      string,
      'bumper_pages' | 'shared_groups' | undefined,
      readonly UnifiedPickerItem[],
      readonly string[],
      (ids: string[]) => void,
    ];
    const specs: Pk[] = isPageBumper
      ? [
          [
            '目标专页',
            'bumper_pages',
            ctx.pageTargetItems,
            step.pageIds,
            (pageIds) => ctx.updateStep(idx, { ...step, pageIds }),
          ],
        ]
      : step.type === 'group-bumper' || step.type === 'bluestacks-group-bumper'
        ? [
            [
              '目标小组',
              'shared_groups',
              ctx.groupTargetItems,
              asIds(step.groupIds),
              (groupIds) => ctx.updateStep(idx, { ...step, groupIds }),
            ],
            [
              '识别主页',
              'bumper_pages',
              ctx.pageTargetItems,
              step.pageIds,
              (pageIds) => ctx.updateStep(idx, { ...step, pageIds }),
            ],
          ]
        : step.type === 'group-poster' || step.type === 'bluestacks-group-poster'
          ? [
              [
                '发帖素材',
                undefined,
                ctx.posterMaterialItems,
                step.materialIds,
                (materialIds) => ctx.updateStep(idx, { ...step, materialIds }),
              ],
              [
                '目标小组',
                'shared_groups',
                ctx.groupTargetItems,
                asIds(step.groupIds),
                (groupIds) => ctx.updateStep(idx, { ...step, groupIds }),
              ],
            ]
          : step.type === 'group-inviter' || step.type === 'bluestacks-group-inviter'
            ? [
                [
                  '目标小组',
                  'shared_groups',
                  step.type === 'bluestacks-group-inviter'
                    ? ctx.groupTargetItems
                    : ctx.inviterGroupTargetItems,
                  step.groupIds,
                  (groupIds) => ctx.updateStep(idx, { ...step, groupIds }),
                ],
              ]
            : [];
    if (!specs.length) return null;
    const nodes = specs.map(([title, listKind, items, selectedIds, onChange], pi) => (
      <UnifiedTargetPicker
        key={title}
        title={title}
        listKind={listKind}
        showCodeSub={Boolean(listKind)}
        items={items}
        selectedIds={selectedIds}
        onChange={onChange}
        onDone={pi === specs.length - 1 ? () => ctx.setExpandedStepId(null) : undefined}
      />
    ));
    return specs.length > 1 ? (
      <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-2">{nodes}</div>
    ) : (
      nodes
    );
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-[10px] py-[7px]">
      <div className="flex flex-wrap items-center gap-[7px]">
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--surface)] text-[11px] font-bold">
          {idx + 1}
        </span>
        <select
          aria-label={`第 ${idx + 1} 步动作`}
          className={UI_SELECT_SM}
          value={step.type}
          onChange={(e) => {
            const nextType = e.target.value as AnyStep['type'],
              fresh = ctx.makeStep(nextType);
            ctx.updateStep(idx, fresh);
            ctx.setExpandedStepId(
              ctx.stepMeta.find((m) => m.type === nextType)?.needsDrawer ? fresh.id : null,
            );
            ctx.setParamOpenStepId(null);
          }}
        >
          {selectMeta.map((m) => (
            <option key={m.type} value={m.type}>
              {m.label}
            </option>
          ))}
        </select>

        <div className="flex min-w-[140px] flex-1 flex-wrap items-center gap-1.5">
          {(step.type === 'quick-browse' || step.type === 'bluestacks-quick-browse') && (
            <>
              <select
                aria-label="浏览目标"
                className={UI_SELECT_SM}
                value={step.target}
                onChange={(e) =>
                  ctx.updateStep(idx, {
                    ...step,
                    target: e.target.value === 'video' ? 'video' : 'feed',
                  })
                }
              >
                <option value="feed">首页</option>
                <option value="video">Reels</option>
              </select>
              <SchedNum
                aria="浏览分钟"
                val={step.durationMinutes}
                min={1}
                max={step.type === 'bluestacks-quick-browse' ? 60 : 120}
                unit="分"
                onChange={(durationMinutes) => ctx.updateStep(idx, { ...step, durationMinutes })}
              />
            </>
          )}

          {(step.type === 'active-combination' || isBsCombo) &&
            (ctx.savedCombos.length > 0 ? (
              <select
                aria-label="选择活跃组合"
                className={UI_SELECT_SM}
                value={step.combinationId}
                onChange={(e) => ctx.updateStep(idx, { ...step, combinationId: e.target.value })}
              >
                {!ctx.savedCombos.some((c) => c.id === step.combinationId) && (
                  <option value={step.combinationId} disabled>
                    （组合已删除）
                  </option>
                )}
                {ctx.savedCombos.map((c) => {
                  const endless = c.saved?.loop.mode === 'until-stopped',
                    unsupported = isBsCombo && isUnsupportedOnBluestacks(c);
                  return (
                    <option key={c.id} value={c.id} disabled={endless || unsupported}>
                      {c.saved?.name || '未命名'}
                      {endless ? '（无限循环）' : unsupported ? '（仅浏览器）' : ''}
                    </option>
                  );
                })}
              </select>
            ) : (
              <span className="text-xs text-amber-700">需先新建活跃组合</span>
            ))}

          {step.type === 'bluestacks-health-check' && (
            <UiSwitch
              ariaLabel="缺包自动安装"
              label="缺包自动安装"
              checked={Boolean(step.autoInstallApk)}
              onCheckedChange={(checked) =>
                ctx.updateStep(idx, { ...step, autoInstallApk: checked })
              }
            />
          )}

          {drawer && (
            <button
              type="button"
              className={`${TARGET_BTN} ${drawer.needsAttention ? 'border-amber-500 bg-amber-50 text-amber-700 hover:bg-amber-100/70' : 'border-[var(--line)] bg-[var(--surface)] text-[var(--text)] hover:bg-slate-100'}`}
              onClick={() => {
                ctx.setParamOpenStepId(null);
                ctx.setExpandedStepId(isOpen ? null : step.id);
              }}
            >
              {drawer.text} {isOpen ? '▴' : '▾'}
            </button>
          )}

          {isBumper && (
            <button
              type="button"
              className={`${TARGET_BTN} ${step.settingsOverride ? 'border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand-hover)]' : 'border-[var(--line)] bg-[var(--surface)] text-[var(--text)] hover:bg-slate-100'}`}
              title={bumperSummary}
              onClick={() => {
                ctx.setExpandedStepId(null);
                ctx.setParamOpenStepId(isParamOpen ? null : step.id);
              }}
            >
              <IconSliders size={12} /> {step.settingsOverride ? bumperSummary : '默认参数'}{' '}
              {isParamOpen ? '▴' : '▾'}
            </button>
          )}

          {(step.type === 'group-poster' || step.type === 'bluestacks-group-poster') && (
            <>
              <SchedNum
                aria="单号发帖小组数"
                val={step.maxGroupsPerProfile}
                min={1}
                max={50}
                unit="组/号"
                onChange={(maxGroupsPerProfile) =>
                  ctx.updateStep(idx, { ...step, maxGroupsPerProfile })
                }
              />
              <SchedNum
                aria="每组发几条素材"
                val={step.materialsPerGroup ?? 1}
                min={1}
                max={50}
                unit="条/组"
                onChange={(materialsPerGroup) =>
                  ctx.updateStep(idx, { ...step, materialsPerGroup })
                }
              />
              {step.type === 'bluestacks-group-poster' && (
                <Chk
                  className="whitespace-nowrap text-[12.5px] text-[var(--text-2)]"
                  label="发时间线"
                  checked={Boolean(step.postToTimeline)}
                  onChange={(v) => ctx.updateStep(idx, { ...step, postToTimeline: v })}
                />
              )}
            </>
          )}

          {(step.type === 'group-inviter' || step.type === 'bluestacks-group-inviter') && (
            <SchedNum
              aria="每群邀请人数"
              val={step.invitesPerGroup}
              min={1}
              max={50}
              unit="人/群"
              onChange={(invitesPerGroup) => ctx.updateStep(idx, { ...step, invitesPerGroup })}
            />
          )}
        </div>

        {totalSteps > 1 && (
          <div className="flex items-center gap-[3px]">
            {(
              [
                ['上移', idx === 0, () => ctx.setSteps((p) => moveItem(p, idx, -1)), '↑', false],
                [
                  '下移',
                  idx === totalSteps - 1,
                  () => ctx.setSteps((p) => moveItem(p, idx, 1)),
                  '↓',
                  false,
                ],
                [
                  '删除',
                  false,
                  () => ctx.setSteps((p) => p.filter((_, i) => i !== idx)),
                  '×',
                  true,
                ],
              ] as const
            ).map(([t, dis, fn, sym, danger]) => (
              <button
                key={t}
                type="button"
                title={t}
                disabled={dis}
                onClick={fn}
                className={`inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-[var(--line)] bg-[var(--surface)] text-xs text-[var(--text-2)] transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${danger ? 'hover:not-disabled:border-red-300 hover:not-disabled:bg-red-50 hover:not-disabled:text-red-600' : 'hover:not-disabled:bg-slate-100'}`}
              >
                {sym}
              </button>
            ))}
          </div>
        )}
      </div>

      {isOpen && renderPickers()}

      {isParamOpen && isBumper && (
        <div className="flex flex-col gap-2.5 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5">
          <div className="flex items-center justify-between gap-2 text-xs text-[var(--text-2)]">
            <span>
              {step.settingsOverride
                ? '已启用步骤独立参数（仅作用于此步，覆盖全局配置）'
                : '当前跟随全局顶贴配置，修改任意项即自动保存为此步独立参数'}
            </span>
            <div className="flex items-center gap-1.5">
              {step.settingsOverride && (
                <button
                  type="button"
                  className="text-xs cursor-pointer rounded-[5px] border-0 bg-transparent px-1.5 py-0.5 text-[var(--brand)] hover:bg-[var(--brand-soft)] hover:text-[var(--brand-hover)]"
                  onClick={() => {
                    const { settingsOverride: _removed, ...rest } = step;
                    ctx.updateStep(idx, rest as AnyStep);
                  }}
                >
                  恢复默认
                </button>
              )}
              <Btn onClick={() => ctx.setParamOpenStepId(null)}>收起</Btn>
            </div>
          </div>
          <BumperSettingsFields
            pageMode={isPageBumper}
            bluestacks={isBsBumper}
            disabled={ctx.saving}
            value={step.settingsOverride}
            onChange={(nextOverride) =>
              ctx.updateStep(
                idx,
                isBsBumper
                  ? {
                      ...step,
                      enableSound: nextOverride.enableSound,
                      settingsOverride: nextOverride,
                    }
                  : { ...step, settingsOverride: nextOverride },
              )
            }
          />
        </div>
      )}
    </div>
  );
}
