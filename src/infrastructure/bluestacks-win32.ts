import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { createHmac } from 'node:crypto';
export interface BlueStacksRunningWindow {
  pid: number;
  hwnd: string;
  title: string;
  listeningPorts: number[];
}
export type BlueStacksHdPlayerProcess = { pid: number; commandLine: string };
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
export interface BlueStacksMonitorBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}
export type BlueStacksCloseTarget = number | { pid: number; hwnd?: string | number | undefined };
const runPs = (runProc: RunProcessFn, script: string, timeoutMs: number) =>
  runProc(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    { timeoutMs },
  );
const WIN32_CSHARP_SOURCE = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class BsWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  public class WinInfo { public long Hwnd; public int Pid; public bool Visible; public int Left, Top, Width, Height; public int IsQtMain; public long Area; public string ClassName, Title; }
  public static List<WinInfo> ListForPids(HashSet<int> pids) {
    var list = new List<WinInfo>();
    EnumWindows((h, l) => {
      uint p = 0; GetWindowThreadProcessId(h, out p);
      if (!pids.Contains((int)p)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, sb.Capacity);
      var cb = new StringBuilder(256); GetClassName(h, cb, cb.Capacity);
      RECT r; GetWindowRect(h, out r);
      int w = Math.Max(0, r.Right - r.Left), ht = Math.Max(0, r.Bottom - r.Top);
      string cls = cb.ToString();
      int qt = cls.IndexOf("QWindowIcon", StringComparison.OrdinalIgnoreCase) >= 0 ? 1 : 0;
      list.Add(new WinInfo { Hwnd = h.ToInt64(), Pid = (int)p, Visible = IsWindowVisible(h), Left = r.Left, Top = r.Top, Width = w, Height = ht, IsQtMain = qt, Area = (long)w * ht, ClassName = cls, Title = sb.ToString() });
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static void ClickClient(IntPtr hwnd, int x, int y) {
    IntPtr lp = (IntPtr)((y << 16) | (x & 0xFFFF));
    PostMessage(hwnd, 0x0200, IntPtr.Zero, lp); PostMessage(hwnd, 0x0201, (IntPtr)1, lp); PostMessage(hwnd, 0x0202, IntPtr.Zero, lp);
  }
}`;
const PS_QUERY_BODY = `$procs = @(Get-Process -Name 'HD-Player' -ErrorAction SilentlyContinue); if ($procs.Count -eq 0) { return @() }
$pidSet = New-Object 'System.Collections.Generic.HashSet[int]'; foreach ($pr in $procs) { [void]$pidSet.Add([int]$pr.Id) }
$wins = @([BsWin32]::ListForPids($pidSet) | Where-Object { $_.Visible -and $_.Title -ne '' }); $portsByPid = @{}
try { foreach ($c in @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $pidSet.Contains([int]$_.OwningProcess) })) { $k = [int]$c.OwningProcess; if (-not $portsByPid.ContainsKey($k)) { $portsByPid[$k] = New-Object System.Collections.ArrayList }; $pnum = [int]$c.LocalPort; if (-not $portsByPid[$k].Contains($pnum)) { [void]$portsByPid[$k].Add($pnum) } } } catch {}
return @(foreach ($pr in $procs) { $id = [int]$pr.Id; $best = @($wins | Where-Object { $_.Pid -eq $id }) | Sort-Object @{ Expression = { $_.IsQtMain }; Descending = $true }, @{ Expression = { $_.Area }; Descending = $true } | Select-Object -First 1; [PSCustomObject]@{ pid = $id; hwnd = $(if ($best) { [string]$best.Hwnd } else { '0' }); title = $(if ($best) { [string]$best.Title } else { [string]$pr.MainWindowTitle }); listeningPorts = $(if ($portsByPid.ContainsKey($id)) { @($portsByPid[$id]) } else { @() }) } })`;
const PS_FOCUS_BODY = `param([Int64]$hwndVal, [int]$pidVal)
$h = [IntPtr]::new($hwndVal); if ($h -eq [IntPtr]::Zero -and $pidVal -gt 0) { try { $h = (Get-Process -Id $pidVal -ErrorAction Stop).MainWindowHandle } catch {} }
if ($h -eq [IntPtr]::Zero) { return $false }
if (-not ([BsWin32]::GetForegroundWindow() -eq $h -and -not [BsWin32]::IsIconic($h))) {
  [void][BsWin32]::ShowWindow($h, $(if ([BsWin32]::IsIconic($h)) { 9 } else { 5 }))
  [void][BsWin32]::BringWindowToTop($h); [void][BsWin32]::SetForegroundWindow($h)
}
return $true`;
const PS_ARRANGE_FN = `
function Invoke-BsArrange($area, [Int64[]]$hwnds, [int]$cols, [int]$gap) {
  $count = $hwnds.Count; if ($count -eq 0) { return 0 }
  if ($cols -le 0) {
    if ($count -le 5) { $cols = $count } elseif ($count -le 8) { $cols = [int][Math]::Ceiling($count / 2.0) }
    else { $cols = [int][Math]::Ceiling([Math]::Sqrt($count * 1.4)) }
  }
  $rows = [int][Math]::Ceiling($count / [double]$cols)
  $cellW = [int][Math]::Floor(($area.Width - ($cols + 1) * $gap) / $cols)
  $cellH = [int][Math]::Floor(($area.Height - ($rows + 1) * $gap) / $rows)
  $idealW = [int][Math]::Min($cellW, [Math]::Max(340, [Math]::Round($cellH * 0.62)))
  $idealH = [int][Math]::Min($cellH, [Math]::Max(520, [Math]::Round($idealW / 0.54)))
  $arranged = 0
  for ($i = 0; $i -lt $count; $i++) {
    $h = [IntPtr]::new($hwnds[$i]); [void][BsWin32]::ShowWindow($h, 9)
    if ([BsWin32]::MoveWindow($h, $area.Left + $gap + ($i % $cols) * ($idealW + $gap), $area.Top + $gap + [int][Math]::Floor($i / $cols) * ($idealH + $gap), $idealW, $idealH, $true)) { $arranged++ }
  }
  return $arranged
}`;
const PS_CLOSE_BODY = `
function Find-PlayerMainHwnd([int]$pidVal, [Int64]$hintHwnd) {
  if ($hintHwnd -gt 0 -and [BsWin32]::IsWindow([IntPtr]::new($hintHwnd))) { return $hintHwnd }
  $pset = New-Object 'System.Collections.Generic.HashSet[int]'; [void]$pset.Add($pidVal)
  $wins = [BsWin32]::ListForPids($pset)
  foreach ($filter in @({ $_.Visible -and $_.ClassName -like 'Qt*QWindowIcon*' -and $_.Title -ne '' }, { $_.Visible -and $_.Title -ne '' -and $_.ClassName -like 'Qt*' }, { $_.Visible -and $_.Title -ne '' -and $_.Width -gt 200 })) {
    $hit = $wins | Where-Object $filter | Sort-Object -Property @{ Expression = { $_.Area }; Descending = $true } | Select-Object -First 1
    if ($hit) { return $hit.Hwnd }
  }
  return [Int64]0
}
function Confirm-CloseDialog([int]$pidVal, [Int64]$mainHwnd, [bool]$allowCoordFallback) {
  $pset = New-Object 'System.Collections.Generic.HashSet[int]'; [void]$pset.Add($pidVal)
  $dlg = [BsWin32]::ListForPids($pset) | Where-Object { $_.Visible -and $_.Hwnd -ne $mainHwnd -and $_.Width -ge 180 -and $_.Height -ge 90 -and $_.ClassName -like 'Qt*QWindow*' } | Select-Object -First 1
  if (-not $dlg) { return $false }
  $confirmed = $false
  try {
    $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($dlg.Hwnd))
    if ($el) {
      $targetBtn = $null; $footerFallback = $null; $dlgRect = $el.Current.BoundingRectangle
      $dlgMidY = if ($dlgRect.Height -gt 0) { $dlgRect.Top + $dlgRect.Height * 0.5 } else { $dlg.Top + $dlg.Height * 0.5 }
      foreach ($child in $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($child.Current.ControlType.ProgrammaticName -ne 'ControlType.Button') { continue }
        $nm = [string]$child.Current.Name
        if ($nm -match '(?:关闭|關閉|Close|Close now|Exit|Quit|确定|確定|Confirm|OK|Yes)' -and $nm -notmatch '(?:取消|Cancel|No|否|继续|Continue)') { $targetBtn = $child; break }
        $r = $child.Current.BoundingRectangle
        if ($r.Width -ge 48 -and $r.Height -ge 26 -and $r.Top -ge $dlgMidY -and (-not $footerFallback -or $r.Left -gt $footerFallback.Current.BoundingRectangle.Left)) { $footerFallback = $child }
      }
      if (-not $targetBtn) { $targetBtn = $footerFallback }
      if ($targetBtn) {
        $pat = $null
        if ($targetBtn.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) { $pat.Invoke(); $confirmed = $true }
        else {
          $br = $targetBtn.Current.BoundingRectangle
          $cx = [int](($br.Left + $br.Width / 2) - $dlg.Left); $cy = [int](($br.Top + $br.Height / 2) - $dlg.Top)
          if ($cx -gt 0 -and $cy -gt 0) { [BsWin32]::ClickClient([IntPtr]::new($dlg.Hwnd), $cx, $cy); $confirmed = $true }
        }
      }
    }
  } catch {}
  if (-not $confirmed -and $allowCoordFallback) { [BsWin32]::ClickClient([IntPtr]::new($dlg.Hwnd), [int]($dlg.Width * 0.82), [int]($dlg.Height * 0.78)); $confirmed = $true }
  return $confirmed
}
$mainHwnds = @{}; $confirmedPids = @{}
foreach ($t in $targets) {
  $id = [int]$t.Pid
  try {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if (-not $p -or $p.ProcessName -ne 'HD-Player') { continue }
    $mh = Find-PlayerMainHwnd $id ([Int64]$t.Hwnd); $mainHwnds[$id] = $mh
    if ($mh -gt 0) { [void][BsWin32]::PostMessage([IntPtr]::new($mh), 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) } else { $null = $p.CloseMainWindow() }
  } catch {}
}
$startedAt = Get-Date; $dialogDeadline = $startedAt.AddSeconds(3.5); $graceDeadline = $startedAt.AddSeconds(6)
while ((Get-Date) -lt $graceDeadline) {
  $alive = @(); $allowFallback = ((Get-Date) - $startedAt).TotalMilliseconds -ge 800
  foreach ($t in $targets) {
    $id = [int]$t.Pid; $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'HD-Player') {
      $alive += $id
      if (-not $confirmedPids.ContainsKey($id) -and (Get-Date) -lt $dialogDeadline -and (Confirm-CloseDialog $id ([Int64]$mainHwnds[$id]) $allowFallback)) { $confirmedPids[$id] = $true }
    }
  }
  if ($alive.Count -eq 0) { break }; Start-Sleep -Milliseconds 250
}
foreach ($t in $targets) { try { $p = Get-Process -Id ([int]$t.Pid) -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'HD-Player') { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } } catch {} }`;
const PERSISTENT_WIN32_PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue
Add-Type @"
${WIN32_CSHARP_SOURCE}
"@
${PS_ARRANGE_FN}
$writeLock = New-Object object; $closeLock = New-Object object
$activeClosers = New-Object System.Collections.ArrayList
function Write-Rpc([hashtable]$obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 5
  [System.Threading.Monitor]::Enter($writeLock)
  try { [Console]::Out.WriteLine($json); [Console]::Out.Flush() } finally { [System.Threading.Monitor]::Exit($writeLock) }
}
function Invoke-BsQuery {
${PS_QUERY_BODY}
}
function Invoke-BsFocus {
${PS_FOCUS_BODY}
}
$closeWorkerScript = {
  param($reqId, $targets, $wl)
  $ErrorActionPreference = 'SilentlyContinue'
  try {
    ${PS_CLOSE_BODY}
    $json = @{ id = [int]$reqId; ok = $true; result = $true } | ConvertTo-Json -Compress
  } catch { $json = @{ id = [int]$reqId; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress }
  [System.Threading.Monitor]::Enter($wl)
  try { [Console]::Out.WriteLine($json); [Console]::Out.Flush() } finally { [System.Threading.Monitor]::Exit($wl) }
}
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line -eq '__EXIT__') { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  [System.Threading.Monitor]::Enter($closeLock)
  try {
    for ($i = $activeClosers.Count - 1; $i -ge 0; $i--) {
      $c = $activeClosers[$i]
      if ($c.Async.IsCompleted) { try { $c.Ps.EndInvoke($c.Async) } catch {}; try { $c.Ps.Dispose() } catch {}; try { $c.Rs.Dispose() } catch {}; $activeClosers.RemoveAt($i) }
    }
  } finally { [System.Threading.Monitor]::Exit($closeLock) }
  $reqId = 0
  try {
    $req = $line | ConvertFrom-Json; $reqId = [int]$req.id; $op = [string]$req.op; $p = $req.params
    if ($op -eq 'ping') { Write-Rpc @{ id = $reqId; ok = $true; result = $PID }; continue }
    if ($op -eq 'query') { Write-Rpc @{ id = $reqId; ok = $true; result = @(Invoke-BsQuery) }; continue }
    if ($op -eq 'listHdPlayer') {
      $rows = @(Get-CimInstance Win32_Process -Filter "Name = 'HD-Player.exe'" -ErrorAction SilentlyContinue | ForEach-Object { [PSCustomObject]@{ pid = [int]$_.ProcessId; commandLine = [string]$_.CommandLine } })
      Write-Rpc @{ id = $reqId; ok = $true; result = @($rows) }; continue
    }
    if ($op -eq 'focus') { Write-Rpc @{ id = $reqId; ok = $true; result = (Invoke-BsFocus ([Int64]$p.hwnd) ([int]$p.pid)) }; continue }
    if ($op -eq 'arrange') {
      $area = if ($null -ne $p.monitorBounds) { [PSCustomObject]@{ Left = [int]$p.monitorBounds.left; Top = [int]$p.monitorBounds.top; Width = [int]$p.monitorBounds.width; Height = [int]$p.monitorBounds.height } } else { [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea }
      $hwnds = [Int64[]]@($p.hwnds | ForEach-Object { [Int64]$_ })
      Write-Rpc @{ id = $reqId; ok = $true; result = (Invoke-BsArrange $area $hwnds ([int]$p.cols) ([int]$p.gap)) }; continue
    }
    if ($op -eq 'close') {
      $rpcTargets = @($p.targets | ForEach-Object { @{ Pid = [int]$_.pid; Hwnd = [Int64]$_.hwnd } })
      $rs = [runspacefactory]::CreateRunspace(); $rs.Open()
      $ps = [powershell]::Create(); $ps.Runspace = $rs
      [void]$ps.AddScript($closeWorkerScript).AddArgument($reqId).AddArgument($rpcTargets).AddArgument($writeLock)
      $ar = $ps.BeginInvoke()
      [System.Threading.Monitor]::Enter($closeLock)
      try { [void]$activeClosers.Add([PSCustomObject]@{ Ps = $ps; Rs = $rs; Async = $ar }) } finally { [System.Threading.Monitor]::Exit($closeLock) }
      continue
    }
    Write-Rpc @{ id = $reqId; ok = $false; error = "UNKNOWN_OP:$op" }
  } catch { Write-Rpc @{ id = $reqId; ok = $false; error = $_.Exception.Message } }
}`;
export type SpawnWin32PsFn = () => ChildProcessWithoutNullStreams;
const defaultSpawnWin32Ps: SpawnWin32PsFn = () =>
  spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      PERSISTENT_WIN32_PS_SCRIPT,
    ],
    { windowsHide: true },
  );
export function attachChildJsonlReader<T>(
  child: ChildProcessWithoutNullStreams,
  isCurrent: () => boolean,
  onMessage: (parsed: T) => void,
): void {
  let buf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    if (!isCurrent()) return;
    buf += chunk.toString('utf8');
    let nlIdx: number;
    while ((nlIdx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nlIdx).trim();
      buf = buf.slice(nlIdx + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line) as T);
      } catch {}
    }
  });
}
export class PersistentWin32PsHelper {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private closed = false;
  private readonly spawnChild: SpawnWin32PsFn;
  private readonly pending = new Map<
    number,
    {
      child: ChildProcessWithoutNullStreams;
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(options: { spawnChild?: SpawnWin32PsFn } = {}) {
    this.spawnChild = options.spawnChild ?? defaultSpawnWin32Ps;
  }
  private syncChildRef(): void {
    const child = this.proc;
    if (!child) return;
    const active = this.pending.size > 0;
    for (const target of [child, child.stdin, child.stdout, child.stderr]) {
      if (!target || typeof target !== 'object') continue;
      const obj = target as { ref?: () => void; unref?: () => void };
      if (active) obj.ref?.();
      else obj.unref?.();
    }
  }
  private flushForChild(child: ChildProcessWithoutNullStreams, reason: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.child !== child) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new Error(reason));
    }
    if (this.proc === child) this.proc = null;
  }
  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.closed) throw new Error('WIN32_HELPER_DISPOSED');
    if (this.proc && !this.proc.killed && this.proc.exitCode === null && this.proc.stdin.writable)
      return this.proc;
    const child = this.spawnChild();
    attachChildJsonlReader<{ id?: number; ok?: boolean; result?: unknown; error?: string }>(
      child,
      () => this.proc === child,
      (parsed) => {
        if (typeof parsed.id !== 'number') return;
        const waiter = this.pending.get(parsed.id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.pending.delete(parsed.id);
        this.syncChildRef();
        if (parsed.ok === false)
          waiter.reject(new Error(String(parsed.error ?? 'WIN32_RPC_ERROR')));
        else waiter.resolve(parsed.result);
      },
    );
    child.stderr.resume();
    child.stdin.on('error', () => this.flushForChild(child, 'WIN32_PIPE_ERROR'));
    child.on('exit', () => this.flushForChild(child, 'WIN32_HELPER_EXITED'));
    child.on('error', () => this.flushForChild(child, 'WIN32_HELPER_ERROR'));
    this.proc = child;
    this.syncChildRef();
    return child;
  }
  async call<T = unknown>(
    op: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    if (this.closed) throw new Error('WIN32_HELPER_DISPOSED');
    const child = this.ensureProcess();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        if (op !== 'close') {
          if (this.proc === child) this.proc = null;
          try {
            child.kill();
          } catch {}
        } else this.syncChildRef();
        reject(new Error('TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { child, resolve: (v) => resolve(v as T), reject, timer });
      this.syncChildRef();
      try {
        child.stdin.write(JSON.stringify({ id, op, params }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.flushForChild(child, err instanceof Error ? err.message : 'WIN32_WRITE_FAILED');
        reject(err instanceof Error ? err : new Error('WIN32_WRITE_FAILED'));
      }
    });
  }
  dispose(): void {
    this.closed = true;
    const child = this.proc;
    this.proc = null;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new Error('WIN32_HELPER_DISPOSED'));
    }
    if (child) {
      try {
        if (child.stdin.writable) child.stdin.write('__EXIT__\n');
      } catch {}
      try {
        child.kill();
      } catch {}
    }
  }
}
let sharedWin32Helper: PersistentWin32PsHelper | null = null;
let exitHookRegistered = false;
function getSharedWin32Helper(): PersistentWin32PsHelper {
  if (!sharedWin32Helper) sharedWin32Helper = new PersistentWin32PsHelper();
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.once('exit', () => disposeBlueStacksWin32Helper());
  }
  return sharedWin32Helper;
}
export function disposeBlueStacksWin32Helper(): void {
  if (sharedWin32Helper) {
    sharedWin32Helper.dispose();
    sharedWin32Helper = null;
  }
}
export function generateTotpCode(base32Secret: string, nowMs = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = base32Secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (cleaned.length < 8) throw new Error('2FA 密钥格式无效（需为 Base32 密钥）');
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
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(nowMs / 1000 / 30)));
  const hmac = createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const o = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((hmac[o] ?? 0) & 0x7f) << 24) |
    (((hmac[o + 1] ?? 0) & 0xff) << 16) |
    (((hmac[o + 2] ?? 0) & 0xff) << 8) |
    ((hmac[o + 3] ?? 0) & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}
export const isPrintableAscii = (text: string): boolean => /^[\x20-\x7e]+$/.test(text);
export const quoteForAndroidInputText = (text: string): string =>
  `'${text.replace(/ /g, '%s').replace(/'/g, `'\\''`)}'`;
function normalizeRunningWindows(parsed: unknown): BlueStacksRunningWindow[] {
  const arr = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const results: BlueStacksRunningWindow[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const pid = Number(rec.pid);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const rawPorts = Array.isArray(rec.listeningPorts) ? rec.listeningPorts : [];
    results.push({
      pid,
      hwnd: typeof rec.hwnd === 'string' ? rec.hwnd : String(rec.hwnd ?? '0'),
      title: typeof rec.title === 'string' ? rec.title.trim() : '',
      listeningPorts: rawPorts.map(Number).filter((p) => Number.isFinite(p) && p > 0),
    });
  }
  return results;
}
export async function queryHdPlayerProcessesViaWin32Helper(): Promise<
  BlueStacksHdPlayerProcess[] | null
> {
  if (process.platform !== 'win32') return null;
  try {
    const raw = await getSharedWin32Helper().call<unknown>('listHdPlayer', {}, 6000);
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return arr.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const rec = item as Record<string, unknown>;
      const pid = Number(rec.pid);
      const commandLine = typeof rec.commandLine === 'string' ? rec.commandLine.trim() : '';
      return Number.isFinite(pid) && pid > 0 && commandLine ? [{ pid, commandLine }] : [];
    });
  } catch {
    return null;
  }
}
export async function queryRunningBlueStacksWindows(
  runProc?: RunProcessFn,
): Promise<BlueStacksRunningWindow[]> {
  if (process.platform !== 'win32') return [];
  if (!runProc) {
    try {
      return normalizeRunningWindows(await getSharedWin32Helper().call<unknown>('query', {}, 8000));
    } catch {
      return [];
    }
  }
  const psScript = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
${WIN32_CSHARP_SOURCE}
"@
function Invoke-BsQuery { ${PS_QUERY_BODY} }
ConvertTo-Json -InputObject @(Invoke-BsQuery) -Compress -Depth 3`;
  try {
    const raw = (await runPs(runProc, psScript, 6000)).toString('utf8').trim();
    return raw ? normalizeRunningWindows(JSON.parse(raw)) : [];
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
  const byTitle = (q: string) =>
    q ? windows.find((w) => w.title.trim().toLowerCase() === q) : undefined;
  const exact = byTitle(normName) ?? byTitle(normKey);
  if (exact) return exact;
  if (!target.sharedPort && target.adbPort > 0)
    return windows.find((w) => w.listeningPorts.includes(target.adbPort)) ?? null;
  if (target.sharedPort && target.adbPort > 0) {
    const onPort = windows.filter((w) => w.listeningPorts.includes(target.adbPort));
    if (onPort.length === 1 && onPort[0]) {
      const winTitle = onPort[0].title.trim().toLowerCase();
      if (!winTitle || winTitle === normName || winTitle === normKey) return onPort[0];
    }
  }
  return null;
}
export async function focusBlueStacksWindow(
  runProc: RunProcessFn | undefined,
  hwnd: string,
  pid: number,
): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const safeHwnd = /^\d+$/.test(hwnd) && hwnd !== '0' ? hwnd : '0';
  if (!runProc) {
    try {
      return Boolean(
        await getSharedWin32Helper().call<boolean>('focus', { hwnd: safeHwnd, pid }, 6000),
      );
    } catch {
      return false;
    }
  }
  const psScript = `Add-Type @"
${WIN32_CSHARP_SOURCE}
"@
function Invoke-BsFocus { ${PS_FOCUS_BODY} }
if (Invoke-BsFocus ([Int64]${safeHwnd}) ${pid}) { Write-Output 'OK' }`;
  try {
    return (await runPs(runProc, psScript, 5000)).toString('utf8').includes('OK');
  } catch {
    return false;
  }
}
export async function arrangeBlueStacksWindows(
  runProc: RunProcessFn | undefined,
  items: readonly { hwnd: string; pid: number }[],
  options: { columns?: number; gap?: number; monitorBounds?: BlueStacksMonitorBounds } = {},
): Promise<number> {
  if (process.platform !== 'win32' || items.length === 0) return 0;
  const validHwnds = items
    .map((i) => (/^\d+$/.test(i.hwnd) && i.hwnd !== '0' ? i.hwnd : null))
    .filter((h): h is string => h !== null);
  if (validHwnds.length === 0) return 0;
  const gap = Math.max(0, Math.min(40, Math.round(options.gap ?? 8)));
  const colsOverride = options.columns ? Math.max(1, Math.min(10, Math.round(options.columns))) : 0;
  const mb = options.monitorBounds;
  const normalizedBounds =
    mb &&
    Number.isFinite(mb.left) &&
    Number.isFinite(mb.top) &&
    Number.isFinite(mb.width) &&
    Number.isFinite(mb.height)
      ? {
          left: Math.round(mb.left),
          top: Math.round(mb.top),
          width: Math.max(100, Math.round(mb.width)),
          height: Math.max(100, Math.round(mb.height)),
        }
      : null;
  if (!runProc) {
    try {
      const n = Number(
        await getSharedWin32Helper().call<number>(
          'arrange',
          { hwnds: validHwnds, cols: colsOverride, gap, monitorBounds: normalizedBounds },
          8000,
        ),
      );
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }
  const areaExpr = normalizedBounds
    ? `[PSCustomObject]@{ Left = ${normalizedBounds.left}; Top = ${normalizedBounds.top}; Width = ${normalizedBounds.width}; Height = ${normalizedBounds.height} }`
    : '[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea';
  const psScript = `Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
${WIN32_CSHARP_SOURCE}
"@
${PS_ARRANGE_FN}
$area = ${areaExpr}; $hwnds = [Int64[]]@(${validHwnds.map((h) => `[Int64]${h}`).join(',')})
Write-Output (Invoke-BsArrange $area $hwnds ${colsOverride} ${gap})`;
  try {
    const n = Number((await runPs(runProc, psScript, 8000)).toString('utf8').trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
export async function closeBlueStacksPids(
  runProc: RunProcessFn | undefined,
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
    if (prev === undefined || (!prev && validHwnd)) byPid.set(pid, validHwnd);
  }
  if (byPid.size === 0) return;
  if (!runProc) {
    const rpcTargets = [...byPid.entries()].map(([pid, hwnd]) => ({ pid, hwnd: hwnd || '0' }));
    await getSharedWin32Helper()
      .call<boolean>('close', { targets: rpcTargets }, 32_000)
      .catch(() => null);
    return;
  }
  const entries = [...byPid.entries()].map(
    ([pid, hwnd]) => `@{ Pid = ${pid}; Hwnd = [Int64]${hwnd || '0'} }`,
  );
  const psScript = `$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue
Add-Type @"
${WIN32_CSHARP_SOURCE}
"@
$targets = @(${entries.join(', ')})
${PS_CLOSE_BODY}`;
  await runPs(runProc, psScript, 32_000).catch(() => null);
}
