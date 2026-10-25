import { useEffect, useRef, useState } from 'react';
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
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog ref={dialog} className="name-dialog" onCancel={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h3>{title}</h3>
        <input
          autoFocus
          required
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label={title}
        />
        {error && <p className="text-danger">{error}</p>}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
