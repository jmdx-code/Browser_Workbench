import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isLocalAvatar } from '../../shared/group-bumper.js';
import { clampCrop, getCanonicalFrame, type RectBounds } from './vision-xml.js';
const WINRT_OCR_POWERSHELL_SCRIPT = `
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter, Windows.Foundation, ContentType = WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod })[0]
function Await-WinRT($op, [Type]$resultType) {
  return $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op)).GetAwaiter().GetResult()
}
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line -eq "__EXIT__") { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $reqId = 0
  try {
    $req = $line | ConvertFrom-Json
    $reqId = [int]$req.id
    if ($null -eq $engine) {
      [Console]::Out.WriteLine((@{ id = $reqId; text = "" } | ConvertTo-Json -Compress))
      [Console]::Out.Flush()
      continue
    }
    $bytes = [Convert]::FromBase64String([string]$req.b64)
    $stream = $null; $writer = $null; $bmp = $null
    try {
      $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
      $writer = New-Object Windows.Storage.Streams.DataWriter($stream.GetOutputStreamAt(0))
      $writer.WriteBytes($bytes)
      $null = Await-WinRT ($writer.StoreAsync()) ([uint32])
      $writer.DetachStream() | Out-Null; $writer.Dispose(); $writer = $null
      $stream.Seek(0)
      $decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bmp = Await-WinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $res = Await-WinRT ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
      [Console]::Out.WriteLine((@{ id = $reqId; text = [string]$res.Text } | ConvertTo-Json -Compress))
      [Console]::Out.Flush()
    } finally {
      if ($null -ne $bmp) { try { $bmp.Dispose() } catch {} }
      if ($null -ne $writer) { try { $writer.Dispose() } catch {} }
      if ($null -ne $stream) { try { $stream.Dispose() } catch {} }
    }
  } catch {
    [Console]::Out.WriteLine((@{ id = $reqId; text = "" } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
  }
}
`;
export interface OcrRecognizer {
  recognizeBounds(pngBuffer: Buffer, bounds: RectBounds): Promise<string>;
  close(): void;
}
export class WindowsOcrClient implements OcrRecognizer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    number,
    { resolve: (text: string) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private queue: Promise<unknown> = Promise.resolve();
  private ensureProcess(): ChildProcessWithoutNullStreams | null {
    if (this.closed || process.platform !== 'win32') return null;
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) return this.proc;
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        WINRT_OCR_POWERSHELL_SCRIPT,
      ],
      { windowsHide: true },
    );
    this.stdoutBuffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString('utf8');
      let nlIdx: number;
      while ((nlIdx = this.stdoutBuffer.indexOf('\n')) !== -1) {
        const line = this.stdoutBuffer.slice(0, nlIdx).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(nlIdx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { id?: number; text?: string };
          if (typeof parsed.id === 'number') {
            const waiter = this.pending.get(parsed.id);
            if (waiter) {
              clearTimeout(waiter.timer);
              this.pending.delete(parsed.id);
              waiter.resolve(String(parsed.text ?? ''));
            }
          }
        } catch {}
      }
    });
    const flushPendingEmpty = () => {
      this.clearPending();
      if (this.proc === child) this.proc = null;
    };
    child.stderr.resume();
    child.stdin.on('error', flushPendingEmpty);
    child.on('exit', flushPendingEmpty);
    child.on('error', flushPendingEmpty);
    this.proc = child;
    return child;
  }
  private buildUpscaledContrastPngBase64(
    pngBuffer: Buffer,
    bounds: RectBounds,
  ): Promise<string | null> {
    return withCroppedCanvas(pngBuffer, bounds, 10, (canvas, crop, createCanvas) => {
      const scale = crop.height <= 46 ? 3 : 2,
        pad = 18,
        innerW = crop.width * scale,
        innerH = crop.height * scale,
        outW = innerW + pad * 2,
        outH = innerH + pad * 2,
        out = createCanvas(outW, outH),
        ctx = out.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(canvas, crop.left, crop.top, crop.width, crop.height, pad, pad, innerW, innerH);
      const imgData = ctx.getImageData(0, 0, outW, outH),
        d = imgData.data;
      let minL = 255,
        maxL = 0;
      for (let y = pad; y < pad + innerH; y++)
        for (let x = pad; x < pad + innerW; x++) {
          const i = (y * outW + x) * 4,
            lum = Math.round(
              0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0),
            );
          d[i] = lum;
          if (lum < minL) minL = lum;
          if (lum > maxL) maxL = lum;
        }
      const span = Math.max(1, maxL - minL);
      for (let y = pad; y < pad + innerH; y++)
        for (let x = pad; x < pad + innerW; x++) {
          const i = (y * outW + x) * 4,
            stretched = span >= 20 ? Math.round((((d[i] ?? 0) - minL) * 255) / span) : (d[i] ?? 0);
          d[i] = d[i + 1] = d[i + 2] = stretched;
          d[i + 3] = 255;
        }
      ctx.putImageData(imgData, 0, 0);
      return Buffer.from(out.toBuffer('image/png')).toString('base64');
    });
  }
  async recognizeBounds(pngBuffer: Buffer, bounds: RectBounds): Promise<string> {
    const task = this.queue.then(async () => {
      if (this.closed) return '';
      try {
        const b64 = await this.buildUpscaledContrastPngBase64(pngBuffer, bounds);
        if (!b64) return '';
        const child = this.ensureProcess();
        if (!child || !child.stdin.writable) return '';
        const id = this.nextId++;
        const rawText = await new Promise<string>((resolve) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            if (this.proc === child) this.proc = null;
            try {
              child.kill();
            } catch {}
            resolve('');
          }, 8000);
          this.pending.set(id, { resolve, timer });
          child.stdin.write(JSON.stringify({ id, b64 }) + '\n');
        });
        return rawText.replace(/\s+/g, ' ').trim();
      } catch {
        return '';
      }
    });
    this.queue = task.catch(() => '');
    return task;
  }
  private clearPending(): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.resolve('');
      this.pending.delete(id);
    }
  }
  close(): void {
    this.closed = true;
    this.clearPending();
    if (this.proc) {
      try {
        if (this.proc.stdin.writable) this.proc.stdin.write('__EXIT__\n');
        this.proc.kill();
      } catch {}
      this.proc = null;
    }
  }
}
const MAX_LOCAL_AVATAR_LEN = 128 * 1024;
const MAX_SIGNATURE_CACHE = 512;
async function withCroppedCanvas<T>(
  pngBuffer: Buffer,
  bounds: RectBounds,
  pad: number,
  draw: (
    canvas: NonNullable<Awaited<ReturnType<typeof getCanonicalFrame>>>['canvas'],
    crop: NonNullable<ReturnType<typeof clampCrop>>,
    createCanvas: typeof import('@napi-rs/canvas').createCanvas,
  ) => T,
): Promise<T | null> {
  const frame = await getCanonicalFrame(pngBuffer),
    crop = frame ? clampCrop(bounds.x1, bounds.y1, bounds.w, bounds.h, pad) : null;
  if (!frame || !crop) return null;
  try {
    const { createCanvas } = await import('@napi-rs/canvas');
    return draw(frame.canvas, crop, createCanvas);
  } catch {
    return null;
  }
}
export async function cropToDataUrl(
  pngBuffer: Buffer,
  bounds: RectBounds,
  size = 96,
): Promise<string | null> {
  return withCroppedCanvas(pngBuffer, bounds, 8, (canvas, crop, createCanvas) => {
    const out = createCanvas(size, size),
      side = Math.min(crop.width, crop.height);
    out
      .getContext('2d')
      .drawImage(
        canvas,
        crop.left + (crop.width - side) / 2,
        crop.top + (crop.height - side) / 2,
        side,
        side,
        0,
        0,
        size,
        size,
      );
    for (const mime of ['image/webp', 'image/jpeg'] as const) {
      for (const quality of [82, 65]) {
        const encoded =
          mime === 'image/webp'
            ? out.toBuffer('image/webp', quality)
            : out.toBuffer('image/jpeg', quality);
        const dataUrl = `data:${mime};base64,${Buffer.from(encoded).toString('base64')}`;
        if (isLocalAvatar(dataUrl) && dataUrl.length <= MAX_LOCAL_AVATAR_LEN) return dataUrl;
      }
    }
    return null;
  });
}
function rgbaToNormalizedSignature(rgba: Uint8ClampedArray): Float32Array | null {
  const rgbLen = (rgba.length / 4) * 3;
  if (rgbLen <= 0) return null;
  const vec = new Float32Array(rgbLen);
  let sum = 0,
    p = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i] ?? 0,
      g = rgba[i + 1] ?? 0,
      b = rgba[i + 2] ?? 0;
    vec[p++] = r;
    vec[p++] = g;
    vec[p++] = b;
    sum += r + g + b;
  }
  const mean = sum / rgbLen;
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = (vec[i] ?? 0) - mean;
    vec[i] = v;
    normSq += v * v;
  }
  const norm = Math.sqrt(normSq);
  if (norm < 160) return null;
  for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) / norm;
  return vec;
}
export function getRegionSignature(
  pngBuffer: Buffer,
  bounds: RectBounds,
): Promise<Float32Array | null> {
  return withCroppedCanvas(pngBuffer, bounds, 8, (canvas, crop, createCanvas) => {
    const c = createCanvas(32, 24),
      ctx = c.getContext('2d');
    ctx.drawImage(canvas, crop.left, crop.top, crop.width, crop.height, 0, 0, 32, 24);
    return rgbaToNormalizedSignature(ctx.getImageData(0, 0, 32, 24).data);
  });
}
export function signatureSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return Math.max(0, Math.min(1, (dot + 1) / 2));
}
const avatarFeatureCache = new Map<string, Float32Array[]>();
function extractAvatarMaskedVector(rgba: Uint8ClampedArray): Float32Array | null {
  if (rgba.length < 24 * 24 * 4) return null;
  const out: number[] = [];
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      const dx = x - 11.5,
        dy = y - 11.5;
      if (dx * dx + dy * dy > 8.8 * 8.8) continue;
      const bdx = x - 20.5,
        bdy = y - 20.0;
      if (bdx * bdx + bdy * bdy <= 6.8 * 6.8) continue;
      const idx = (y * 24 + x) * 4;
      out.push((rgba[idx] ?? 0) / 255, (rgba[idx + 1] ?? 0) / 255, (rgba[idx + 2] ?? 0) / 255);
    }
  }
  return out.length > 0 ? new Float32Array(out) : null;
}
function hybridAvatarVectorSimilarity(a: Float32Array, b: Float32Array): number {
  const n = a.length;
  if (n === 0 || n !== b.length) return 0;
  let dotRaw = 0,
    na = 0,
    nb = 0,
    mad = 0,
    sumA = 0,
    sumB = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0,
      bi = b[i] ?? 0;
    dotRaw += ai * bi;
    na += ai * ai;
    nb += bi * bi;
    mad += Math.abs(ai - bi);
    sumA += ai;
    sumB += bi;
  }
  const cosRaw = na > 1e-6 && nb > 1e-6 ? dotRaw / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  const rawScore = cosRaw * Math.max(0, 1 - (mad / n) * 0.65);
  const meanA = sumA / n,
    meanB = sumB / n;
  let dotZ = 0,
    va = 0,
    vb = 0;
  for (let i = 0; i < n; i++) {
    const da = (a[i] ?? 0) - meanA,
      db = (b[i] ?? 0) - meanB;
    dotZ += da * db;
    va += da * da;
    vb += db * db;
  }
  const znccScore =
    va > 1e-5 && vb > 1e-5
      ? Math.max(0, Math.min(1, (dotZ / (Math.sqrt(va) * Math.sqrt(vb)) + 1) / 2))
      : rawScore;
  return 0.55 * rawScore + 0.45 * znccScore;
}
async function getReferenceAvatarVariants(referenceUrl: string): Promise<Float32Array[] | null> {
  const cached = avatarFeatureCache.get(referenceUrl);
  if (cached) return cached;
  try {
    let inputBuffer: Buffer;
    if (referenceUrl.startsWith('data:image/')) {
      const b64 = referenceUrl.split(',')[1];
      if (!b64) return null;
      inputBuffer = Buffer.from(b64, 'base64');
    } else if (referenceUrl.startsWith('https://') || referenceUrl.startsWith('http://')) {
      const res = await fetch(referenceUrl, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      inputBuffer = Buffer.from(await res.arrayBuffer());
    } else return null;
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(inputBuffer);
    if (!img.width || !img.height) return null;
    const c = createCanvas(24, 24),
      ctx = c.getContext('2d'),
      baseSide = Math.min(img.width, img.height);
    const variants: Float32Array[] = [];
    for (const cropFrac of [1.0, 0.86, 0.78]) {
      for (const offsetY of [-0.05, 0, 0.05]) {
        const sw = baseSide * cropFrac,
          sh = baseSide * cropFrac,
          sx = (img.width - sw) / 2;
        const sy = Math.max(
          0,
          Math.min(img.height - sh, (img.height - sh) / 2 + baseSide * offsetY),
        );
        ctx.clearRect(0, 0, 24, 24);
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, 24, 24);
        const vec = extractAvatarMaskedVector(ctx.getImageData(0, 0, 24, 24).data);
        if (vec) variants.push(vec);
      }
    }
    if (variants.length > 0) {
      if (avatarFeatureCache.size >= MAX_SIGNATURE_CACHE) {
        const oldestKey = avatarFeatureCache.keys().next().value;
        if (oldestKey !== undefined) avatarFeatureCache.delete(oldestKey);
      }
      avatarFeatureCache.set(referenceUrl, variants);
      return variants;
    }
    return null;
  } catch {
    return null;
  }
}
function getRegionAvatarVector(
  pngBuffer: Buffer,
  bounds: RectBounds,
): Promise<Float32Array | null> {
  return withCroppedCanvas(pngBuffer, bounds, 8, (canvas, crop, createCanvas) => {
    const c = createCanvas(24, 24),
      ctx = c.getContext('2d'),
      side = Math.min(crop.width, crop.height);
    ctx.drawImage(
      canvas,
      crop.left + (crop.width - side) / 2,
      crop.top + (crop.height - side) / 2,
      side,
      side,
      0,
      0,
      24,
      24,
    );
    return extractAvatarMaskedVector(ctx.getImageData(0, 0, 24, 24).data);
  });
}
export async function compareAvatarToRegion(
  pngBuffer: Buffer,
  bounds: RectBounds,
  referenceAvatarUrl: string | null,
): Promise<number> {
  if (!referenceAvatarUrl) return 0;
  const [regionVec, refVariants] = await Promise.all([
    getRegionAvatarVector(pngBuffer, bounds),
    getReferenceAvatarVariants(referenceAvatarUrl),
  ]);
  if (!regionVec || !refVariants || refVariants.length === 0) return 0;
  let best = 0;
  for (const refVec of refVariants) {
    const sim = hybridAvatarVectorSimilarity(regionVec, refVec);
    if (sim > best) best = sim;
  }
  return best;
}
