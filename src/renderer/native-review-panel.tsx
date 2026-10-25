import { useEffect, useRef, useState } from 'react';
import type { Profile } from '../shared/contracts.js';
import type { NativeReview } from '../shared/native-review.js';
import { api } from './api.js';

const phases = {
  DISPATCHING: '发送结果待确认',
  ACKNOWLEDGED: '输入已接收，尚未结算',
  UNKNOWN: '结果未知',
};
export function NativeReviewPanel({ profile }: { profile: Profile }) {
  const [report, setReport] = useState<NativeReview | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), [profile.id]);
  const read = async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setReport(null);
    try {
      const value = await api.nativeReview(profile.id, controller.signal);
      if (value.profileId !== profile.id) throw Error('任务诊断资料不匹配');
      if (!controller.signal.aborted) setReport(value);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : '任务诊断失败');
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <section className="inspection-panel" aria-label="浏览器未决任务诊断">
      <div className="inspection-heading">
        <h3>浏览器任务诊断</h3>
        <button disabled={busy || !profile.online} onClick={() => void read()}>
          {busy ? '读取中…' : '读取未决记录'}
        </button>
      </div>
      <p className="muted">
        用于检查浏览器为何无法继续。点击后只读取插件保存的原任务记录，不打开网页或重做任务。
      </p>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {report && (
        <>
          <p>
            {report.blockingCount !== undefined
              ? `仍需处理 ${report.blockingCount} 个操作，另保留 ${report.unresolvedCount - report.blockingCount} 个已结束的历史未确认记录。`
              : report.unresolvedCount
                ? `${report.unresolvedCount} 个操作尚未结算。`
                : '浏览器没有未结算操作。'}
            {report.activeTabCount !== undefined
              ? `${report.activeTabCount} 个已登记页面仍保留。`
              : report.unclosedTabCount
                ? `${report.unclosedTabCount} 个任务页尚未确认关闭。`
                : '没有待关闭确认的任务页。'}
          </p>
          {report.tabs?.map((tab) => (
            <p key={tab.id} className="muted">
              {tab.reason === 'WORKSPACE_MAIN_IDLE'
                ? '主工作页 · 空闲可复用'
                : `检查页 ${tab.state} · ${tab.hasProof ? '有准确归属' : '创建结果未确认'} · ${tab.reason}`}
            </p>
          ))}
          <small>
            读取时间 {new Date(report.checkedAt).toLocaleString()}
            。页面关闭和停止确认不能代替操作结果；此结果不会解除占用或确认发布。
          </small>
          {report.operations.map((op) => (
            <details key={op.id}>
              <summary>
                {op.local?.name ?? '当前工作区之外的原任务'} ·{' '}
                {op.ended ? '已结束 · 历史结果未知' : phases[op.nativeState]}
              </summary>
              <p>
                账号 {op.accountId} · 操作编号 <code>{op.id}</code>
              </p>
              {op.local ? (
                <p>
                  软件记录：{op.local.operationState}；
                  {op.ended
                    ? '本次任务已结束；原历史停止记录保留'
                    : op.local.controlConfirmed
                      ? '停止已确认'
                      : '停止尚未确认'}
                  。请在下方对应任务查看原操作。
                </p>
              ) : (
                <p>
                  当前工作区没有匹配的原绑定。需要从原工作区或测试报告核对这项记录，不能在这里清除、重试或据此认定发布成功。
                </p>
              )}
            </details>
          ))}
          {report.truncated && <p className="muted">显示最近100个未结算操作，数量包含全部记录。</p>}
        </>
      )}
    </section>
  );
}
