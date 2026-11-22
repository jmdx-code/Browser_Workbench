import { useEffect, useRef, useState } from 'react';

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
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
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
      className="name-dialog confirm-dialog"
      aria-label={title}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else closeDialog();
      }}
    >
      <h3>{title}</h3>
      <p>{description}</p>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <footer>
        <button type="button" autoFocus disabled={busy} onClick={closeDialog}>
          取消
        </button>
        <button
          type="button"
          className={danger ? 'danger' : 'primary'}
          disabled={busy}
          onClick={() => void confirm()}
        >
          {busy ? '处理中…' : confirmLabel}
        </button>
      </footer>
    </dialog>
  );
}
