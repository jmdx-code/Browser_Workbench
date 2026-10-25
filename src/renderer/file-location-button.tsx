import { useState } from 'react';
import { FileLocationResult } from '../shared/desktop.js';
export function FileLocationButton({ source, label }: { source: string; label: string }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const desktop = window.workbenchDesktop;
  if (!desktop?.revealLocalFile) return null;
  return (
    <span className="file-location-action">
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError('');
          void desktop
            .revealLocalFile(source)
            .then((value) => {
              const result = FileLocationResult.parse(value);
              if (!result.ok) setError(result.error);
            })
            .catch(() => setError('文件位置未打开，请重试'))
            .finally(() => setBusy(false));
        }}
      >
        {label}
      </button>
      {error && <small role="alert">{error}</small>}
    </span>
  );
}
