import { ProductError, failError } from '../../domain/workspace.js';
import {
  StartBluestacksBatchLoginInput,
  bluestacksDisplayTitle,
  maskLoginAccountLabel,
  normalizeTotpSecret,
  type BluestacksBatchLoginItemProgress,
  type BluestacksBatchLoginState,
} from '../../shared/bluestacks.js';
import { runPatrolItemLifecycle, saveLastStatusSafe } from './bs-op-helpers.js';
import { joinLabels, runPatrolBatch, stopPatrolBatch } from './bs-patrols.js';
import type { BluestacksServiceContext } from './bs-types.js';
export function recomputeBatchLoginCounts(state: BluestacksBatchLoginState): void {
  const c = { succeeded: 0, skipped: 0, verification: 0, restricted: 0, failed: 0, stopped: 0 };
  let completed = 0;
  for (const item of state.items) {
    if (item.status === 'queued' || item.status === 'running') continue;
    completed++;
    c[item.status]++;
  }
  Object.assign(state, { completed, ...c });
  const bad = c.verification + c.restricted + c.failed;
  state.statusText = state.running
    ? `正在批量登录 (${completed}/${state.total} · 成功 ${c.succeeded}${bad > 0 ? ` · 异常/失败 ${bad}` : ''})`
    : `批量登录已结束 (${completed}/${state.total} · ${joinLabels([
        ['成功', c.succeeded],
        ['跳过', c.skipped],
        ['待验证', c.verification],
        ['受限', c.restricted],
        ['失败', c.failed],
        ['已停', c.stopped],
      ])})`;
}
export async function startBatchLogin(
  ctx: BluestacksServiceContext,
  input: unknown,
): Promise<void> {
  if (ctx.batchLoginStarting || ctx.batchLoginState?.running)
    failError(
      'BATCH_LOGIN_ALREADY_RUNNING',
      '当前已有批量自动登录任务正在运行，请等待完成或先停止',
      409,
    );
  const parsed = StartBluestacksBatchLoginInput.parse(input);
  const loginFn = ctx.devices.loginAccountDetailed;
  if (!loginFn) throw new ProductError('BLUESTACKS_UNSUPPORTED', '当前环境不支持自动登录', 400);
  const seenIds = new Set<string>();
  for (const entry of parsed.items) {
    if (seenIds.has(entry.instanceId))
      failError(
        'BATCH_LOGIN_DUPLICATE_INSTANCE',
        '批量登录列表中存在重复的蓝蝶实例，请确保每个蓝蝶窗口仅分配一个账号',
        400,
      );
    seenIds.add(entry.instanceId);
  }
  const volatileQueue = parsed.items.map((e, index) => ({
    index,
    instanceId: e.instanceId,
    account: e.account,
    password: e.password,
    totpSecret: e.totpSecret ? normalizeTotpSecret(e.totpSecret) : '',
  }));
  const scrub = (e: { account: string; password: string; totpSecret: string }) =>
    void (e.account = e.password = e.totpSecret = '');
  let runState!: BluestacksBatchLoginState;
  await runPatrolBatch({
    ctx,
    kind: 'batch-login',
    entries: volatileQueue,
    getInstanceId: (e) => e.instanceId,
    maxConcurrency: parsed.maxConcurrency,
    initRun: (cap, byId) => {
      const items: BluestacksBatchLoginItemProgress[] = parsed.items.map((e) => {
        const inst = byId.get(e.instanceId);
        return {
          instanceId: e.instanceId,
          instanceName: inst ? bluestacksDisplayTitle(inst) : e.instanceId.slice(0, 8),
          maskedAccount: maskLoginAccountLabel(e.account),
          hasTotp: Boolean(e.totpSecret?.trim()),
          status: 'queued',
          stepText: '排队等待并发槽位…',
        };
      });
      runState = {
        runId: crypto.randomUUID(),
        running: true,
        startedAt: Date.now(),
        finishedAt: null,
        total: items.length,
        completed: 0,
        succeeded: 0,
        skipped: 0,
        verification: 0,
        restricted: 0,
        failed: 0,
        stopped: 0,
        statusText: `准备批量登录 ${items.length} 台蓝蝶（并发 ${cap}）…`,
        items,
      };
      ctx.batchLoginState = runState;
      return {
        runState,
        recompute: () => recomputeBatchLoginCounts(runState),
        setAbortAndPromise: (abort, promise) => {
          ctx.batchLoginAbort = abort;
          ctx.batchLoginRunnerPromise = promise;
        },
        onFinallyClear: () => {
          for (const e of volatileQueue) scrub(e);
          ctx.batchLoginAbort = null;
          ctx.batchLoginRunnerPromise = null;
        },
      };
    },
    onAbortedItem: (next) => {
      scrub(next);
      const it = runState.items[next.index];
      if (!it || it.status !== 'queued') return;
      Object.assign(it, { status: 'stopped', stepText: '已取消排队', finishedAt: Date.now() });
      recomputeBatchLoginCounts(runState);
    },
    runItem: async (entry, parentSig) => {
      const item = runState.items[entry.index];
      if (!item) return scrub(entry);
      let skipAlreadyLoggedIn = false;
      await runPatrolItemLifecycle({
        ctx,
        kind: 'batch-login',
        item,
        parentSignal: parentSig,
        autoLaunch: parsed.autoLaunch,
        autoInstallApk: parsed.autoInstallApk,
        persistStepStatus: true,
        defaultErr: '自动登录异常',
        closeOnFinish: parsed.closeOnFinish,
        onCheckSkip: (inst) => {
          if (
            parsed.ifAlreadyLoggedIn === 'skip' &&
            inst.accountState === 'logged-in' &&
            inst.accountName
          ) {
            skipAlreadyLoggedIn = true;
            Object.assign(item, {
              status: 'skipped',
              accountName: inst.accountName,
              numericAccountId: inst.numericAccountId || undefined,
              stepText: `已登录（${inst.accountName}），按策略跳过`,
            });
            return true;
          }
          ctx.loggingInIds.add(entry.instanceId);
          return false;
        },
        onPrepFailed: (prep) => {
          if (skipAlreadyLoggedIn) return;
          if (prep.reason === 'stopped')
            Object.assign(item, { status: 'stopped', stepText: '已停止' });
          else if (prep.reason === 'missing' || prep.reason === 'apk-missing') {
            item.status = 'failed';
            item.error =
              prep.reason === 'missing' ? '蓝蝶实例不存在' : '未安装 FB Lite 且未开启自动安装 APK';
            item.stepText = prep.reason === 'missing' ? '实例不存在' : item.error;
          } else {
            item.status = 'skipped';
            item.error =
              prep.reason === 'landscape' && prep.inst
                ? `横屏分辨率 (${prep.inst.fbWidth}×${prep.inst.fbHeight}) 不支持`
                : prep.reason === 'busy'
                  ? '实例正在执行其他任务，已跳过'
                  : '实例未启动且未开启自动拉起';
            item.stepText = item.error;
          }
        },
        execute: async (prep, signal, setStep) => {
          setStep('正在自动登录 FB Lite…');
          const res = await loginFn.call(
            ctx.devices,
            entry.instanceId,
            {
              account: entry.account,
              password: entry.password,
              totpSecret: entry.totpSecret || undefined,
              saveLoginInfo: parsed.saveLoginInfo,
              ifAlreadyLoggedIn: parsed.ifAlreadyLoggedIn,
            },
            signal,
            setStep,
          );
          item.accountName = res.instance.accountName || undefined;
          item.numericAccountId = res.instance.numericAccountId || undefined;
          if (res.skippedAlreadyLoggedIn) {
            item.status = 'skipped';
            item.stepText = `原已登录（${res.instance.accountName || item.instanceName}），已跳过`;
            if (!prep.launched) return false;
          } else {
            item.status = 'succeeded';
            item.stepText = `登录成功 · ${res.instance.accountName || item.instanceName}${res.instance.numericAccountId ? ` · ID ${res.instance.numericAccountId}` : ''}`;
            await saveLastStatusSafe(ctx, entry.instanceId, item.stepText);
          }
        },
        onError: async (msg, stopped, err) => {
          const code = err instanceof ProductError ? err.code : '';
          if (stopped) Object.assign(item, { status: 'stopped', stepText: '已手动停止' });
          else if (code === 'BLUESTACKS_ACCOUNT_CHECKPOINT' || /Checkpoint|安全验证/i.test(msg))
            Object.assign(item, {
              status: 'verification',
              error: msg,
              stepText: '触发安全验证 (Checkpoint)',
            });
          else if (code === 'BLUESTACKS_ACCOUNT_RESTRICTED' || /封禁|停用|受限/i.test(msg))
            Object.assign(item, { status: 'restricted', error: msg, stepText: '账号受限/停用' });
          else
            Object.assign(item, {
              status: 'failed',
              error: msg,
              stepText: `登录失败 · ${msg.slice(0, 80)}`,
            });
          await saveLastStatusSafe(ctx, entry.instanceId, item.stepText);
        },
        onFinally: (claimed) => {
          scrub(entry);
          if (claimed) ctx.loggingInIds.delete(entry.instanceId);
        },
        onAfterItem: () => recomputeBatchLoginCounts(runState),
      });
    },
  });
}
export const stopBatchLogin = (ctx: BluestacksServiceContext): Promise<void> =>
  stopPatrolBatch(
    ctx,
    'batch-login',
    ctx.batchLoginAbort,
    ctx.batchLoginState,
    () => ctx.batchLoginState && recomputeBatchLoginCounts(ctx.batchLoginState),
    ctx.batchLoginRunnerPromise,
  );
