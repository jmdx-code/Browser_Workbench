import { useEffect, useRef, useState } from 'react';

export function ConfirmDialog({
  title,
  description,
  label,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  label: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm();
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作未确认，请重新读取。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="name-dialog confirm-dialog"
      aria-label={title}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
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
        <button autoFocus disabled={busy} onClick={onClose}>
          取消
        </button>
        <button className="danger" disabled={busy} onClick={() => void confirm()}>
          {busy ? '处理中…' : label}
        </button>
      </footer>
    </dialog>
  );
}
