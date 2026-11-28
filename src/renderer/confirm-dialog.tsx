import { useRef, useState } from 'react';
import { Btn, ErrText, useShowModal } from './modules/shared/module-ui.js';
import { UI_DIALOG_CARD } from './ui/primitives.js';
export function ConfirmDialog({
  title,
  description,
  label,
  confirmText,
  danger = true,
  busy: externalBusy = false,
  onConfirm,
  onClose,
  onCancel,
}: {
  title: string;
  description: string;
  label?: string | undefined;
  confirmText?: string | undefined;
  danger?: boolean | undefined;
  busy?: boolean | undefined;
  onConfirm: () => void | Promise<unknown>;
  onClose?: (() => void) | undefined;
  onCancel?: (() => void) | undefined;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submittingRef = useRef(false);
  const [internalBusy, setInternalBusy] = useState(false);
  const [error, setError] = useState('');
  const busy = internalBusy || externalBusy;
  const confirmLabel = label ?? confirmText ?? '确认';
  const closeDialog = onClose ?? onCancel ?? (() => {});
  useShowModal(dialog);
  async function confirm() {
    if (submittingRef.current || busy) return;
    submittingRef.current = true;
    setInternalBusy(true);
    setError('');
    try {
      await onConfirm();
      closeDialog();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作未确认，请重新读取。');
    } finally {
      submittingRef.current = false;
      setInternalBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      role="alertdialog"
      className={`${UI_DIALOG_CARD} confirm-dialog`}
      aria-label={title}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else closeDialog();
      }}
    >
      <h3 className="m-0 text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 mb-3 max-h-[min(45vh,360px)] overflow-y-auto text-[13px] leading-relaxed whitespace-pre-line text-[var(--text-2)]">
        {description}
      </p>
      <ErrText msg={error} className="mb-3" />
      <footer className="mt-4 flex justify-end gap-2">
        <Btn sm={false} autoFocus disabled={busy} onClick={closeDialog}>
          取消
        </Btn>
        <Btn
          v={danger ? 'danger' : 'primary'}
          sm={false}
          disabled={busy}
          onClick={() => void confirm()}
        >
          {busy ? '处理中…' : confirmLabel}
        </Btn>
      </footer>
    </dialog>
  );
}
