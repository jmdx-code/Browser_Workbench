// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../src/shared/contracts.js';
import type { Inspection } from '../src/shared/profile-inspection.js';
import { ConfirmDialog } from '../src/renderer/confirm-dialog.js';
import { InspectionReader } from '../src/renderer/inspection-reader.js';
import { ControlledNumberInput } from '../src/renderer/modules/shared/controlled-number-input.js';
import { WorkspaceReader } from '../src/renderer/workspace-reader.js';

function makeWorkspace(alias = 'Browser 1'): Workspace {
  return {
    groups: [],
    profiles: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        alias,
        browserName: alias,
        groupId: null,
        order: 0,
        online: true,
        phase: 'PAUSED',
        synced: true,
        unresolved: 0,
        extensionVersion: '0.3.84',
        capabilities: [],
        presentation: null,
        account: { state: 'unknown', id: null, name: null, avatar: null },
      },
    ],
    combinations: [],
    records: [],
  };
}

describe('Cycle 3 renderer hardening regressions', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('WorkspaceReader skips redundant idle emits while force=true aborts stale poll and emits post-mutation state', async () => {
    const emitted: Array<Workspace | null> = [];
    let callCount = 0;
    const pendingResolvers: Array<(w: Workspace) => void> = [];
    const reader = new WorkspaceReader(
      (signal) =>
        new Promise<Workspace>((resolve, reject) => {
          callCount += 1;
          const onAbort = () => reject(new Error('aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
          pendingResolvers.push((w) => {
            signal.removeEventListener('abort', onAbort);
            resolve(w);
          });
        }),
      (value) => emitted.push(value),
    );

    const p1 = reader.refresh(false);
    await Promise.resolve();
    pendingResolvers[0]?.(makeWorkspace('A'));
    await p1;
    expect(emitted).toHaveLength(1);

    // Identical idle poll emits nothing
    const p2 = reader.refresh(false);
    await Promise.resolve();
    pendingResolvers[1]?.(makeWorkspace('A'));
    await p2;
    expect(emitted).toHaveLength(1);

    // Concurrent background poll + force=true post-mutation refresh: force wins and emits B
    const stalePoll = reader.refresh(false);
    await Promise.resolve();
    const forced = reader.refresh(true);
    await Promise.resolve();
    expect(callCount).toBe(4);
    pendingResolvers[3]?.(makeWorkspace('B'));
    await Promise.all([stalePoll, forced]);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.profiles[0]?.alias).toBe('B');

    reader.dispose();
  });

  it('InspectionReader deduplicates unchanged polls and supports force=true refresh', async () => {
    const row: Inspection = {
      profileId: '11111111-1111-4111-8111-111111111111',
      state: 'OBSERVED',
      checkedAt: 1000,
      account: { state: 'logged-in', id: '123', name: 'Alice', avatar: null },
      reason: '',
    };
    const emitted: number[] = [];
    let readCalls = 0;
    const reader = new InspectionReader(
      {
        read: async () => {
          readCalls += 1;
          return { results: [row] };
        },
        request: async () => ({ results: [row] }),
      },
      (s) => emitted.push(s.rows.length),
    );

    await reader.refresh(false);
    await reader.refresh(false);
    expect(readCalls).toBe(2);
    expect(emitted).toHaveLength(1);

    await reader.refresh(true);
    expect(readCalls).toBe(3);
    expect(emitted).toHaveLength(2);
    reader.dispose();
  });

  it('ControlledNumberInput uses latest onCommit callback ref when debounced timer fires', async () => {
    vi.useFakeTimers();
    try {
      const commits: Array<{ label: string; value: number }> = [];
      function Harness() {
        const [label, setLabel] = React.useState('v1');
        const [val, setVal] = React.useState(10);
        return (
          <div>
            <ControlledNumberInput
              ariaLabel="num"
              min={1}
              max={100}
              value={val}
              debounceMs={200}
              onChange={(n) => {
                setVal(n);
                setLabel('v2');
              }}
              onCommit={(n) => {
                commits.push({ label, value: n });
              }}
            />
          </div>
        );
      }
      await act(async () => {
        root.render(<Harness />);
      });
      const input = host.querySelector<HTMLInputElement>('input[aria-label="num"]');
      expect(input).toBeTruthy();
      await act(async () => {
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value',
          )?.set;
          setter?.call(input, '42');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await act(async () => {
        vi.advanceTimersByTime(250);
      });
      expect(commits).toEqual([{ label: 'v2', value: 42 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ConfirmDialog blocks synchronous double-click duplicate submissions', async () => {
    let calls = 0;
    let release!: () => void;
    const onConfirm = () =>
      new Promise<void>((resolve) => {
        calls += 1;
        release = resolve;
      });
    await act(async () => {
      root.render(
        <ConfirmDialog
          title="删除测试"
          description="确认操作"
          label="确认删除"
          onConfirm={onConfirm}
          onClose={() => {}}
        />,
      );
    });
    const buttons = [...host.querySelectorAll('button')];
    const confirmBtn = buttons.find((b) => b.textContent?.includes('确认删除'));
    expect(confirmBtn).toBeTruthy();
    await act(async () => {
      confirmBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      confirmBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(calls).toBe(1);
    await act(async () => {
      release();
    });
  });

  it('keeps startup topbar concurrency and auth panel styles inside the single Tailwind v4 stylesheet', () => {
    const tailwindCss = readFileSync(join(process.cwd(), 'src/renderer/ui/tailwind.css'), 'utf8');
    const authPanelTsx = readFileSync(
      join(process.cwd(), 'src/renderer/modules/sheets/google-sheets-auth-panel.tsx'),
      'utf8',
    );
    const topbarTsx = readFileSync(
      join(process.cwd(), 'src/renderer/workbench-topbar.tsx'),
      'utf8',
    );
    const mainTsx = readFileSync(join(process.cwd(), 'src/renderer/main.tsx'), 'utf8');
    expect(tailwindCss).toContain("@import 'tailwindcss';");
    expect(mainTsx).toContain("import './ui/tailwind.css';");
    expect(topbarTsx).toContain('topbar-concurrency-popover');
    expect(authPanelTsx).not.toContain('.css');
    expect(authPanelTsx).toContain('type="file"');
  });
});
