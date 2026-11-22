import { z } from 'zod';
import { Id } from './contracts.js';

export const BluestacksLoginExistingPolicy = z.enum(['skip', 'clear-and-relogin']);
export type BluestacksLoginExistingPolicy = z.infer<typeof BluestacksLoginExistingPolicy>;

export const BluestacksBatchLoginItemStatus = z.enum([
  'queued',
  'running',
  'succeeded',
  'skipped',
  'verification',
  'restricted',
  'failed',
  'stopped',
]);
export type BluestacksBatchLoginItemStatus = z.infer<typeof BluestacksBatchLoginItemStatus>;

export const BluestacksBatchLoginEntryInput = z
  .object({
    instanceId: Id,
    account: z.string().trim().min(1).max(200),
    password: z.string().min(1).max(200),
    totpSecret: z.string().trim().max(200).optional(),
  })
  .strict();
export type BluestacksBatchLoginEntryInput = z.infer<typeof BluestacksBatchLoginEntryInput>;

export const StartBluestacksBatchLoginInput = z
  .object({
    items: z.array(BluestacksBatchLoginEntryInput).min(1).max(200),
    maxConcurrency: z.number().int().min(1).max(20).default(3),
    autoLaunch: z.boolean().default(true),
    autoInstallApk: z.boolean().default(true),
    ifAlreadyLoggedIn: BluestacksLoginExistingPolicy.default('skip'),
    saveLoginInfo: z.boolean().default(true),
    closeOnFinish: z.boolean().default(true),
  })
  .strict();
export type StartBluestacksBatchLoginInput = z.infer<typeof StartBluestacksBatchLoginInput>;

export interface BluestacksBatchLoginItemProgress {
  instanceId: string;
  instanceName: string;
  maskedAccount: string;
  hasTotp: boolean;
  status: BluestacksBatchLoginItemStatus;
  stepText: string;
  accountName?: string;
  numericAccountId?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface BluestacksBatchLoginState {
  runId: string;
  running: boolean;
  startedAt: number;
  finishedAt: number | null;
  total: number;
  completed: number;
  succeeded: number;
  skipped: number;
  verification: number;
  restricted: number;
  failed: number;
  stopped: number;
  statusText: string;
  items: BluestacksBatchLoginItemProgress[];
}

export interface ParsedBatchLoginCredential {
  lineNumber: number;
  account: string;
  password: string;
  totpSecret: string;
}

export interface ParsedBatchLoginError {
  lineNumber: number;
  reason: string;
}

export interface ParsedBatchLoginResult {
  entries: ParsedBatchLoginCredential[];
  errors: ParsedBatchLoginError[];
}

export function normalizeTotpSecret(raw: string): string {
  return raw
    .replace(/[\s-]+/g, '')
    .trim()
    .toUpperCase();
}

export function isValidTotpSecret(raw: string): boolean {
  const clean = normalizeTotpSecret(raw);
  if (!clean || !/^[A-Z2-7]+={0,6}$/.test(clean)) return false;
  const unpadded = clean.replace(/=+$/, '');
  return unpadded.length >= 6;
}

export function maskLoginAccountLabel(account: string): string {
  const trimmed = account.trim();
  if (!trimmed) return '***';
  const atIdx = trimmed.indexOf('@');
  if (atIdx > 0) {
    const local = trimmed.slice(0, atIdx);
    const domain = trimmed.slice(atIdx);
    if (local.length <= 2) return `${local[0] ?? '*'}***${domain}`;
    return `${local.slice(0, 2)}***${local.slice(-1)}${domain}`;
  }
  if (trimmed.length <= 4) {
    return `${trimmed[0] ?? '*'}***`;
  }
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-2)}`;
}

const ACCOUNT_LABEL_RE =
  /^(?:账号|帐号|用户名|邮箱|手机|手机号|登录名|account|email|mail|phone|user|username|uid|id)\s*[:：]\s*(.+)$/i;
const PASSWORD_LABEL_RE = /^(?:密码|口令|登录密码|password|pass|pwd)\s*[:：]\s*(.+)$/i;
const TOTP_LABEL_RE =
  /^(?:totp|2fa|二步验证|双重验证|双重验证码|验证密钥|密钥|验证码密钥|secret|otp|fa|2fa密钥|totp密钥)\s*[:：]\s*(.+)$/i;

function isLikelyHeaderRow(cols: readonly string[]): boolean {
  const c0 = (cols[0] ?? '').trim().toLowerCase();
  const c1 = (cols[1] ?? '').trim().toLowerCase();
  const firstIsHeader = /^(?:账号|帐号|用户名|邮箱|手机|account|email|user|username|uid|id)$/.test(
    c0,
  );
  const secondIsHeader = /^(?:密码|口令|password|pass|pwd)$/.test(c1);
  return firstIsHeader && secondIsHeader;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

function splitDelimitedLine(line: string): string[] | null {
  if (line.includes('\t')) return line.split('\t');
  if (line.includes('----')) return line.split('----');
  if (line.includes('|')) return line.split('|');
  if (line.includes(';')) return line.split(';');
  if (line.includes(',')) return splitCsvLine(line);
  return null;
}

/**
 * Parses batch Facebook Lite login credentials from:
 * 1) Multi-line labeled blocks (`账号: ...` / `密码: ...` / `totp: ...`, preserving `:` and `,` in passwords!)
 * 2) Single-line delimited rows (`\t`, `----`, `|`, `;`, or CSV `,`) with optional 2FA Base32 column.
 */
export function parseBatchLoginText(raw: string): ParsedBatchLoginResult {
  const lines = raw.split(/\r?\n/);
  const entries: ParsedBatchLoginCredential[] = [];
  const errors: ParsedBatchLoginError[] = [];

  let block: {
    startLine: number;
    account: string;
    password: string;
    totpSecret: string;
  } | null = null;

  const flushBlock = () => {
    if (!block) return;
    const cur = block;
    block = null;
    if (!cur.account && !cur.password && !cur.totpSecret) return;
    if (!cur.account) {
      errors.push({ lineNumber: cur.startLine, reason: '缺少账号字段' });
      return;
    }
    if (!cur.password) {
      errors.push({ lineNumber: cur.startLine, reason: '缺少密码字段' });
      return;
    }
    if (cur.totpSecret && !isValidTotpSecret(cur.totpSecret)) {
      errors.push({
        lineNumber: cur.startLine,
        reason: '2FA 密钥格式无效（需为至少 6 位 Base32 字符 A-Z / 2-7）',
      });
      return;
    }
    entries.push({
      lineNumber: cur.startLine,
      account: cur.account,
      password: cur.password,
      totpSecret: cur.totpSecret ? normalizeTotpSecret(cur.totpSecret) : '',
    });
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNum = idx + 1;
    const trimmed = (lines[idx] ?? '').trim();
    if (!trimmed) {
      flushBlock();
      continue;
    }
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
      continue;
    }

    const acctMatch = ACCOUNT_LABEL_RE.exec(trimmed);
    if (acctMatch?.[1] !== undefined) {
      if (block?.account) flushBlock();
      if (!block) {
        block = { startLine: lineNum, account: '', password: '', totpSecret: '' };
      }
      block.account = acctMatch[1].trim();
      continue;
    }

    const passMatch = PASSWORD_LABEL_RE.exec(trimmed);
    if (passMatch?.[1] !== undefined) {
      if (!block) {
        block = { startLine: lineNum, account: '', password: '', totpSecret: '' };
      } else if (block.password) {
        flushBlock();
        block = { startLine: lineNum, account: '', password: '', totpSecret: '' };
      }
      // Preserve literal colons, commas, pipes, etc. inside passwords!
      block.password = passMatch[1].trim();
      continue;
    }

    const totpMatch = TOTP_LABEL_RE.exec(trimmed);
    if (totpMatch?.[1] !== undefined) {
      if (!block) {
        block = { startLine: lineNum, account: '', password: '', totpSecret: '' };
      }
      block.totpSecret = totpMatch[1].trim();
      continue;
    }

    // Non-labeled line: flush any open labeled block first, then parse as delimited single line
    flushBlock();
    const cols = splitDelimitedLine(trimmed);
    if (!cols || cols.length < 2) {
      errors.push({
        lineNumber: lineNum,
        reason: '无法识别分隔符（支持 账号:/密码:/totp: 多行格式，或 | / Tab / ---- / ; / , 分隔）',
      });
      continue;
    }
    if (isLikelyHeaderRow(cols)) {
      continue;
    }

    const account = (cols[0] ?? '').trim();
    const password = (cols[1] ?? '').trim();
    if (!account || !password) {
      errors.push({ lineNumber: lineNum, reason: '账号或密码为空' });
      continue;
    }

    // Pick optional 2FA secret from column 3 (or scan trailing columns preferring real 16+ char Base32 secrets)
    let rawTotp = '';
    const extraCols = cols
      .slice(2)
      .map((c) => c.trim())
      .filter(Boolean);
    if (extraCols.length === 1) {
      rawTotp = extraCols[0] ?? '';
    } else if (extraCols.length > 1) {
      const validExtras = extraCols.filter((c) => isValidTotpSecret(c));
      validExtras.sort((a, b) => {
        const na = normalizeTotpSecret(a);
        const nb = normalizeTotpSecret(b);
        const scoreA = (na.length >= 16 ? 10 : 0) + (/[2-7]/.test(na) ? 5 : 0) + na.length / 100;
        const scoreB = (nb.length >= 16 ? 10 : 0) + (/[2-7]/.test(nb) ? 5 : 0) + nb.length / 100;
        return scoreB - scoreA;
      });
      rawTotp = validExtras[0] ?? extraCols[0] ?? '';
    }

    if (rawTotp && !isValidTotpSecret(rawTotp)) {
      errors.push({
        lineNumber: lineNum,
        reason: '第 3 列 2FA 密钥格式无效（需为至少 6 位 Base32 字符 A-Z / 2-7）',
      });
      continue;
    }

    entries.push({
      lineNumber: lineNum,
      account,
      password,
      totpSecret: rawTotp ? normalizeTotpSecret(rawTotp) : '',
    });
  }

  flushBlock();
  return { entries, errors };
}
