import { useRef, useState } from 'react';
import { Btn, useShowModal } from './modules/shared/module-ui.js';
import { UI_DIALOG_CARD, UI_INPUT } from './ui/primitives.js';

export function NameDialog({
  title,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  initial: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submittingRef = useRef(false);
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useShowModal(dialog);
  async function save() {
    if (!name.trim() || submittingRef.current || busy) return;
    submittingRef.current = true;
    setBusy(true);
    setError('');
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败');
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className={UI_DIALOG_CARD}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h3 className="m-0 text-base font-semibold text-slate-900">{title}</h3>
        <input
          autoFocus
          required
          className={UI_INPUT + ' w-full'}
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label={title}
        />
        {error && <p className="m-0 text-xs font-medium text-rose-600">{error}</p>}
        <footer className="mt-1 flex justify-end gap-2">
          <Btn sm={false} disabled={busy} onClick={onClose}>
            取消
          </Btn>
          <Btn v="primary" sm={false} type="submit" disabled={busy || !name.trim()}>
            {busy ? '保存中…' : '保存'}
          </Btn>
        </footer>
      </form>
    </dialog>
  );
}
