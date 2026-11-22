import { createHmac } from 'node:crypto';
import type { SpawnOptions } from 'node:child_process';

export interface BlueStacksRunningWindow {
  pid: number;
  hwnd: string;
  title: string;
  listeningPorts: number[];
}

export type RunProcessFn = (
  executable: string,
  args: string[],
  options?: {
    input?: Buffer | string;
    timeoutMs?: number;
    maxBytes?: number;
    signal?: AbortSignal;
    spawnOptions?: SpawnOptions;
  },
) => Promise<Buffer>;

/**
 * RFC 6238 6-digit SHA-1 TOTP code generator (30s time step) using Node crypto.
 * Never logs or persists the secret.
 */
export function generateTotpCode(base32Secret: string, nowMs = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = base32Secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (cleaned.length < 8) {
    throw new Error('2FA 密钥格式无效（需为 Base32 密钥）');
  }
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of cleaned) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const key = Buffer.from(bytes);
  const counter = BigInt(Math.floor(nowMs / 1000 / 30));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const hmac = createHmac('sha1', key).update(msg).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

/**
 * Checks whether a string consists purely of printable US-ASCII characters (0x20..0x7E)
 * that Android's `input text` handles natively without touching the host clipboard.
 */
export function isPrintableAscii(text: string): boolean {
  return /^[\x20-\x7e]+$/.test(text);
}

/**
 * Single-quotes a printable ASCII string for Android `/system/bin/sh` + `input text`,
 * converting spaces to `%s` and escaping single quotes safely so special password
 * characters (`^`, `+`, `:`, `?`, `` ` ``, `<`, `>`, `!`, `}`, `,`, etc.) pass literally.
 */
export function quoteForAndroidInputText(text: string): string {
  const escapedSpaces = text.replace(/ /g, '%s');
  return `'${escapedSpaces.replace(/'/g, `'\\''`)}'`;
}

/**
 * Enumerates all running `HD-Player.exe` processes on Windows, combining:
 * 1) Win32 `EnumWindows` + `GetWindowText` (works even when HD-Player runs elevated!)
 * 2) `Get-NetTCPConnection -State Listen` (maps ADB TCP port -> exact PID, including port 5555!)
 */
export async function queryRunningBlueStacksWindows(
  runProc: RunProcessFn,
): Promise<BlueStacksRunningWindow[]> {
  if (process.platform !== 'win32') return [];
  const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class BsWinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  public static List<string[]> ListForPids(HashSet<int> pids) {
    var result = new List<string[]>();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      uint p = 0;
      GetWindowThreadProcessId(hWnd, out p);
      if (!pids.Contains((int)p)) return true;
      var sb = new StringBuilder(512);
      int len = GetWindowText(hWnd, sb, sb.Capacity);
      if (len > 0) {
        var cls = new StringBuilder(128);
        GetClassName(hWnd, cls, cls.Capacity);
        RECT rc;
        long area = 0;
        if (GetWindowRect(hWnd, out rc)) {
          long w = Math.Max(0, rc.Right - rc.Left);
          long h = Math.Max(0, rc.Bottom - rc.Top);
          area = w * h;
        }
        int isQtMain = cls.ToString().IndexOf("QWindowIcon", StringComparison.OrdinalIgnoreCase) >= 0 ? 1 : 0;
        result.Add(new string[] { ((int)p).ToString(), hWnd.ToInt64().ToString(), sb.ToString(), isQtMain.ToString(), area.ToString() });
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
"@
$procs = @(Get-Process -Name 'HD-Player' -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { Write-Output '[]'; exit 0 }
$pidSet = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($pr in $procs) { [void]$pidSet.Add([int]$pr.Id) }
$wins = [BsWinEnum]::ListForPids($pidSet)
$portsByPid = @{}
try {
  $conns = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $pidSet.Contains([int]$_.OwningProcess) })
  foreach ($c in $conns) {
    $k = [int]$c.OwningProcess
    if (-not $portsByPid.ContainsKey($k)) { $portsByPid[$k] = New-Object System.Collections.ArrayList }
    $pnum = [int]$c.LocalPort
    if (-not $portsByPid[$k].Contains($pnum)) { [void]$portsByPid[$k].Add($pnum) }
  }
} catch {}
$out = @()
foreach ($pr in $procs) {
  $id = [int]$pr.Id
  $matched = @($wins | Where-Object { [int]$_[0] -eq $id })
  $best = $matched | Sort-Object @{ Expression = { [int]$_[3] }; Descending = $true }, @{ Expression = { [long]$_[4] }; Descending = $true } | Select-Object -First 1
  $hwnd = if ($best) { [string]$best[1] } else { '0' }
  $title = if ($best) { [string]$best[2] } else { [string]$pr.MainWindowTitle }
  $ports = if ($portsByPid.ContainsKey($id)) { @($portsByPid[$id]) } else { @() }
  $out += [PSCustomObject]@{ pid = $id; hwnd = $hwnd; title = $title; listeningPorts = $ports }
}
ConvertTo-Json -InputObject $out -Compress -Depth 3
`;
  try {
    const buf = await runProc(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
      { timeoutMs: 6000 },
    );
    const raw = buf.toString('utf8').trim();
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const results: BlueStacksRunningWindow[] = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const pid = Number(rec.pid);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      const hwnd = typeof rec.hwnd === 'string' ? rec.hwnd : String(rec.hwnd ?? '0');
      const title = typeof rec.title === 'string' ? rec.title.trim() : '';
      const rawPorts = Array.isArray(rec.listeningPorts) ? rec.listeningPorts : [];
      const listeningPorts = rawPorts
        .map((p) => Number(p))
        .filter((p) => Number.isFinite(p) && p > 0);
      results.push({ pid, hwnd, title, listeningPorts });
    }
    return results;
  } catch {
    return [];
  }
}

export function matchBlueStacksWindow(
  windows: readonly BlueStacksRunningWindow[],
  target: { displayName: string; instanceKey: string; adbPort: number; sharedPort: boolean },
): BlueStacksRunningWindow | null {
  const normName = target.displayName.trim().toLowerCase();
  const normKey = target.instanceKey.trim().toLowerCase();
  // 1. Exact window title match is strongest (disambiguates shared port 5555 cleanly!)
  if (normName) {
    const byExactTitle = windows.find((w) => w.title.trim().toLowerCase() === normName);
    if (byExactTitle) return byExactTitle;
  }
  if (normKey) {
    const byKeyTitle = windows.find((w) => w.title.trim().toLowerCase() === normKey);
    if (byKeyTitle) return byKeyTitle;
  }
  // 2. Non-shared ADB TCP port match
  if (!target.sharedPort && target.adbPort > 0) {
    const byPort = windows.find((w) => w.listeningPorts.includes(target.adbPort));
    if (byPort) return byPort;
  }
  // 3. Shared port match ONLY if exactly one window listens on that port and its title does NOT conflict with target
  if (target.sharedPort && target.adbPort > 0) {
    const onPort = windows.filter((w) => w.listeningPorts.includes(target.adbPort));
    if (onPort.length === 1 && onPort[0]) {
      const winTitle = onPort[0].title.trim().toLowerCase();
      if (!winTitle || winTitle === normName || winTitle === normKey) {
        return onPort[0];
      }
    }
  }
  return null;
}

export async function focusBlueStacksWindow(
  runProc: RunProcessFn,
  hwnd: string,
  pid: number,
): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const safeHwnd = /^\d+$/.test(hwnd) && hwnd !== '0' ? hwnd : '0';
  const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BsWinFocus {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
$h = [IntPtr]::new([Int64]${safeHwnd})
if ($h -eq [IntPtr]::Zero -and ${pid} -gt 0) {
  try { $h = (Get-Process -Id ${pid} -ErrorAction Stop).MainWindowHandle } catch {}
}
if ($h -ne [IntPtr]::Zero) {
  if ([BsWinFocus]::IsIconic($h)) { [void][BsWinFocus]::ShowWindow($h, 9) }
  else { [void][BsWinFocus]::ShowWindow($h, 5) }
  [void][BsWinFocus]::BringWindowToTop($h)
  [void][BsWinFocus]::SetForegroundWindow($h)
  Write-Output 'OK'
}
`;
  try {
    const out = await runProc(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
      { timeoutMs: 5000 },
    );
    return out.toString('utf8').includes('OK');
  } catch {
    return false;
  }
}

export async function arrangeBlueStacksWindows(
  runProc: RunProcessFn,
  items: readonly { hwnd: string; pid: number }[],
  options: { columns?: number; gap?: number } = {},
): Promise<number> {
  if (process.platform !== 'win32' || items.length === 0) return 0;
  const validHwnds = items
    .map((i) => (/^\d+$/.test(i.hwnd) && i.hwnd !== '0' ? i.hwnd : null))
    .filter((h): h is string => h !== null);
  if (validHwnds.length === 0) return 0;
  const gap = Math.max(0, Math.min(40, Math.round(options.gap ?? 8)));
  const colsOverride = options.columns ? Math.max(1, Math.min(10, Math.round(options.columns))) : 0;
  const hwndLiteral = validHwnds.map((h) => `[Int64]${h}`).join(',');

  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BsTile {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
}
"@
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$hwnds = @(${hwndLiteral})
$count = $hwnds.Count
$gap = ${gap}
$cols = ${colsOverride}
if ($cols -le 0) {
  if ($count -le 5) { $cols = $count }
  elseif ($count -le 8) { $cols = [int][Math]::Ceiling($count / 2.0) }
  else { $cols = [int][Math]::Ceiling([Math]::Sqrt($count * 1.4)) }
}
$rows = [int][Math]::Ceiling($count / [double]$cols)
$cellW = [int][Math]::Floor(($area.Width - ($cols + 1) * $gap) / $cols)
$cellH = [int][Math]::Floor(($area.Height - ($rows + 1) * $gap) / $rows)
# Keep comfortable portrait aspect ratio (~0.56 width/height + BlueStacks sidebar/titlebar)
$idealW = [int][Math]::Min($cellW, [Math]::Max(340, [Math]::Round($cellH * 0.62)))
$idealH = [int][Math]::Min($cellH, [Math]::Max(520, [Math]::Round($idealW / 0.54)))
$arranged = 0
for ($i = 0; $i -lt $count; $i++) {
  $r = [int][Math]::Floor($i / $cols)
  $c = $i % $cols
  $x = $area.Left + $gap + $c * ($idealW + $gap)
  $y = $area.Top + $gap + $r * ($idealH + $gap)
  $h = [IntPtr]::new($hwnds[$i])
  [void][BsTile]::ShowWindow($h, 9)
  if ([BsTile]::MoveWindow($h, $x, $y, $idealW, $idealH, $true)) { $arranged++ }
}
Write-Output $arranged
`;
  try {
    const out = await runProc(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
      { timeoutMs: 8000 },
    );
    const n = Number(out.toString('utf8').trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export type BlueStacksCloseTarget =
  | number
  | {
      pid: number;
      hwnd?: string | number | undefined;
    };

/**
 * Gracefully closes BlueStacks 5 `HD-Player.exe` processes without triggering
 * `FATAL: Unexpected shutdown`:
 * 1) Sends `WM_CLOSE` to the real visible Qt main player window (`Qt*QWindowIcon`),
 *    NOT an invisible helper window and NOT `adb shell reboot -p` while `[Ready]`.
 * 2) Automatically confirms BlueStacks's built-in Qt close-confirmation modal
 *    (`关闭 BlueStacks App Player ...`) via UI Automation `InvokePattern.Invoke()`
 *    (non-intrusive: does not move mouse cursor or steal foreground focus).
 * 3) Waits up to 22 seconds for `HD-Player.exe` to flush `bluestacks.conf`, cleanly
 *    power down Android (`GUEST: reboot: Power down`), release locks, and exit with
 *    `Player state : Exiting err: 0, coreSvcErr: 0`, only falling back to force kill
 *    if genuinely hung past the graceful deadline.
 */
export async function closeBlueStacksPids(
  runProc: RunProcessFn,
  targets: readonly BlueStacksCloseTarget[],
): Promise<void> {
  if (process.platform !== 'win32' || targets.length === 0) return;
  const byPid = new Map<number, string>();
  for (const t of targets) {
    const pid = typeof t === 'number' ? t : t.pid;
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const rawHwnd = typeof t === 'number' ? '' : String(t.hwnd ?? '').trim();
    const validHwnd = /^\d+$/.test(rawHwnd) ? rawHwnd : '';
    const prev = byPid.get(pid);
    if (prev === undefined || (!prev && validHwnd)) {
      byPid.set(pid, validHwnd);
    }
  }
  if (byPid.size === 0) return;

  const entries = [...byPid.entries()].map(
    ([pid, hwnd]) => `@{ Pid = ${pid}; Hwnd = [Int64]${hwnd || '0'} }`,
  );
  const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class BsGracefulClose {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public class WinInfo {
    public long Hwnd;
    public bool Visible;
    public int Left;
    public int Top;
    public int Width;
    public int Height;
    public string ClassName;
    public string Title;
  }

  public static List<WinInfo> ListForPid(uint pid) {
    var list = new List<WinInfo>();
    EnumWindows((h, l) => {
      uint p;
      GetWindowThreadProcessId(h, out p);
      if (p == pid) {
        var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
        var cb = new StringBuilder(256); GetClassName(h, cb, 256);
        RECT r; GetWindowRect(h, out r);
        list.Add(new WinInfo {
          Hwnd = h.ToInt64(),
          Visible = IsWindowVisible(h),
          Left = r.Left,
          Top = r.Top,
          Width = r.Right - r.Left,
          Height = r.Bottom - r.Top,
          ClassName = cb.ToString(),
          Title = sb.ToString()
        });
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static void ClickClient(IntPtr hwnd, int x, int y) {
    IntPtr lp = (IntPtr)((y << 16) | (x & 0xFFFF));
    PostMessage(hwnd, 0x0200, IntPtr.Zero, lp);
    PostMessage(hwnd, 0x0201, (IntPtr)1, lp);
    PostMessage(hwnd, 0x0202, IntPtr.Zero, lp);
  }
}
"@

function Find-PlayerMainHwnd([int]$pidVal, [Int64]$hintHwnd) {
  if ($hintHwnd -gt 0 -and [BsGracefulClose]::IsWindow([IntPtr]::new($hintHwnd))) {
    return $hintHwnd
  }
  $wins = [BsGracefulClose]::ListForPid([uint32]$pidVal)
  $iconWin = $wins | Where-Object { $_.Visible -and $_.ClassName -like 'Qt*QWindowIcon*' -and $_.Title -ne '' } |
    Sort-Object -Property @{ Expression = { $_.Width * $_.Height }; Descending = $true } | Select-Object -First 1
  if ($iconWin) { return $iconWin.Hwnd }
  $titled = $wins | Where-Object { $_.Visible -and $_.Title -ne '' -and $_.ClassName -like 'Qt*' } |
    Sort-Object -Property @{ Expression = { $_.Width * $_.Height }; Descending = $true } | Select-Object -First 1
  if ($titled) { return $titled.Hwnd }
  $anyTitled = $wins | Where-Object { $_.Visible -and $_.Title -ne '' -and $_.Width -gt 200 } |
    Sort-Object -Property @{ Expression = { $_.Width * $_.Height }; Descending = $true } | Select-Object -First 1
  if ($anyTitled) { return $anyTitled.Hwnd }
  return [Int64]0
}

function Confirm-CloseDialog([int]$pidVal, [Int64]$mainHwnd, [bool]$allowCoordFallback) {
  $wins = [BsGracefulClose]::ListForPid([uint32]$pidVal)
  $dlg = $wins | Where-Object {
    $_.Visible -and $_.Hwnd -ne $mainHwnd -and $_.Width -ge 180 -and $_.Height -ge 90 -and $_.ClassName -like 'Qt*QWindow*'
  } | Select-Object -First 1
  if (-not $dlg) { return $false }

  $confirmed = $false
  try {
    $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($dlg.Hwnd))
    if ($el) {
      $all = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      $targetBtn = $null
      $footerFallback = $null
      $dlgRect = $el.Current.BoundingRectangle
      $dlgMidY = if ($dlgRect.Height -gt 0) { $dlgRect.Top + $dlgRect.Height * 0.5 } else { $dlg.Top + $dlg.Height * 0.5 }
      foreach ($child in $all) {
        if ($child.Current.ControlType.ProgrammaticName -ne 'ControlType.Button') { continue }
        $nm = [string]$child.Current.Name
        if ($nm -match '(?:关闭|關閉|Close|Close now|Exit|Quit|确定|確定|Confirm|OK|Yes)' -and $nm -notmatch '(?:取消|Cancel|No|否|继续|Continue)') {
          $targetBtn = $child
          break
        }
        $r = $child.Current.BoundingRectangle
        if ($r.Width -ge 48 -and $r.Height -ge 26 -and $r.Top -ge $dlgMidY) {
          if (-not $footerFallback -or $r.Left -gt $footerFallback.Current.BoundingRectangle.Left) {
            $footerFallback = $child
          }
        }
      }
      if (-not $targetBtn) { $targetBtn = $footerFallback }
      if ($targetBtn) {
        $pat = $null
        if ($targetBtn.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
          $pat.Invoke()
          $confirmed = $true
        } else {
          $br = $targetBtn.Current.BoundingRectangle
          $cx = [int](($br.Left + $br.Width / 2) - $dlg.Left)
          $cy = [int](($br.Top + $br.Height / 2) - $dlg.Top)
          if ($cx -gt 0 -and $cy -gt 0) {
            [BsGracefulClose]::ClickClient([IntPtr]::new($dlg.Hwnd), $cx, $cy)
            $confirmed = $true
          }
        }
      }
    }
  } catch {}
  if (-not $confirmed -and $allowCoordFallback) {
    # Coordinate fallback inside BlueStacks's 350x168 close confirmation dialog (bottom-right primary button)
    [BsGracefulClose]::ClickClient([IntPtr]::new($dlg.Hwnd), [int]($dlg.Width * 0.82), [int]($dlg.Height * 0.78))
    $confirmed = $true
  }
  return $confirmed
}

$targets = @(${entries.join(', ')})
$mainHwnds = @{}
$confirmedPids = @{}

foreach ($t in $targets) {
  $id = [int]$t.Pid
  try {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $p -or $p.ProcessName -ne 'HD-Player') { continue }
    $mh = Find-PlayerMainHwnd $id ([Int64]$t.Hwnd)
    $mainHwnds[$id] = $mh
    if ($mh -gt 0) {
      [void][BsGracefulClose]::PostMessage([IntPtr]::new($mh), 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    } else {
      $null = $p.CloseMainWindow()
    }
  } catch {}
}

$startedAt = Get-Date
$dialogDeadline = $startedAt.AddSeconds(7)
$graceDeadline = $startedAt.AddSeconds(22)
while ((Get-Date) -lt $graceDeadline) {
  $alive = @()
  $allowFallback = ((Get-Date) - $startedAt).TotalMilliseconds -ge 1500
  foreach ($t in $targets) {
    $id = [int]$t.Pid
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'HD-Player') {
      $alive += $id
      if (-not $confirmedPids.ContainsKey($id) -and (Get-Date) -lt $dialogDeadline) {
        $mh = if ($mainHwnds.ContainsKey($id)) { [Int64]$mainHwnds[$id] } else { [Int64]0 }
        if (Confirm-CloseDialog $id $mh $allowFallback) {
          $confirmedPids[$id] = $true
        }
      }
    }
  }
  if ($alive.Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
}

foreach ($t in $targets) {
  $id = [int]$t.Pid
  try {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'HD-Player') {
      Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}
`;
  await runProc(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
    { timeoutMs: 32_000 },
  ).catch(() => null);
}
