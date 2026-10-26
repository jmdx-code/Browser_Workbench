import test from 'node:test';
import assert from 'node:assert/strict';
import { copyTextToClipboard } from '../src/renderer/clipboard.js';

for (const mode of ['native', 'denied', 'missing', 'failed', 'empty'] as const)
  test(`clipboard copy ${mode}: native or fallback result is checked and temporary DOM is removed`, async () => {
    const previous = new Map(
      ['navigator', 'document'].map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
    );
    let actual = '',
      appended = 0,
      removed = 0,
      selected = false;
    const area = {
      value: '',
      style: {},
      setAttribute: () => {},
      focus: () => {},
      select: () => {
        selected = true;
      },
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard:
          mode === 'missing'
            ? undefined
            : {
                writeText: async (text: string) => {
                  if (mode !== 'native') throw Error('Write permission denied');
                  actual = text;
                },
              },
      },
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: (tag: string) => {
          assert.equal(tag, 'textarea');
          return area;
        },
        body: {
          appendChild: () => {
            appended++;
          },
          removeChild: () => {
            removed++;
          },
        },
        execCommand: (command: string) => {
          assert.equal(command, 'copy');
          assert.equal(selected, true);
          if (mode === 'failed') return false;
          actual = area.value;
          return true;
        },
      },
    });
    try {
      if (mode === 'failed') await assert.rejects(copyTextToClipboard('插件路径'), /复制未成功/);
      else if (mode === 'empty') await assert.rejects(copyTextToClipboard(''), /没有可复制/);
      else {
        await copyTextToClipboard('插件路径');
        assert.equal(actual, '插件路径');
      }
      assert.equal(appended, mode === 'native' || mode === 'empty' ? 0 : 1);
      assert.equal(removed, appended);
    } finally {
      for (const [key, value] of previous) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
