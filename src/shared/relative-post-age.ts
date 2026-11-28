// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE =
  /[\u001b\u009b](?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
/** Strips ANSI CSI/OSC escape sequences from log and error strings. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_ESCAPE_RE, '');
}
/** Self-contained factory usable both in Node and inside Playwright page.evaluate via serializeDomEval. */
export function createRelativePostAge() {
  const EN_MONTHS = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
  ];
  const normalizeDigits = (input: string): string =>
    input
      .replace(/[\u1040-\u1049]/gu, (ch) => String(ch.charCodeAt(0) - 0x1040))
      .replace(/[\u0e50-\u0e59]/gu, (ch) => String(ch.charCodeAt(0) - 0x0e50));
  function ageFromMonthDay(monthIdx: number, day: number, now: number): number {
    const d = new Date(now);
    const target = new Date(d.getFullYear(), monthIdx, day);
    if (target.getTime() > now) target.setFullYear(d.getFullYear() - 1);
    return Math.max(24, (now - target.getTime()) / 3600000);
  }
  function parseTodayTime(cleaned: string, now: number, justNowHours: number): number | null {
    const todayMatch =
      /(?:today(?:\s+at)?|今天|今日|hôm\s*nay|วันนี้|ယနေ့)(?:\s*(?:(上午|下午|凌晨|晚上|am|pm)\s*)?(\d{1,2}):(\d{2})(?:\s*(am|pm))?)?/iu.exec(
        cleaned,
      );
    if (!todayMatch) return null;
    const hRaw = todayMatch[2];
    const mRaw = todayMatch[3];
    if (hRaw === undefined || mRaw === undefined) return justNowHours;
    let hour = Number(hRaw);
    const minute = Number(mRaw);
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59)
      return justNowHours;
    const meridiem = (todayMatch[1] ?? todayMatch[4] ?? '').toLowerCase();
    if ((meridiem === 'pm' || meridiem === '下午' || meridiem === '晚上') && hour < 12) hour += 12;
    else if ((meridiem === 'am' || meridiem === '上午' || meridiem === '凌晨') && hour === 12)
      hour = 0;
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    return target.getTime() <= now ? Math.max(0, (now - target.getTime()) / 3600000) : 0;
  }
  const JUST_NOW_RE =
    /(?:just\s*now|刚刚|剛剛|則則|则则|ယခုလေးတင်|မကြာသေးမီက|vừa\s*xong|mới\s*đây|เมื่อสักครู่)/u;
  const YESTERDAY_RE = /(?:yesterday|昨天|မနေ့က|hôm\s*qua|เมื่อวาน)/u;
  const YMD_CJK_RE =
    /(?:^|\D)(\d{4})年(1[0-2]|0?[1-9])月([12]\d|3[01]|0?[1-9])(?:日|号|號)(?:\s*(\d{1,2}):(\d{2}))?(?:\D|$)/u;
  const MD_CJK_RE =
    /(?:^|\D)(1[0-2]|0?[1-9])(?:月|[8b])([12]\d|3[01]|0?[1-9])(?:日|号|號|[80b])(?:\D|$)/iu;
  const RELATIVE_UNIT_RE =
    /(?:^|\D)(\d{1,3}(?:\.\d+)?)\s*(s|sec(?:ond)?s?|秒|စက္ကန့်|giây|วินาที|m|min(?:ute)?s?|分钟|分鐘|分|မိနစ်|phút|นาที|h|hrs?|hours?|(?:[刂小]\s*[、丶]?\s*)?(?:小时|小時|时|時)|နာရီ|giờ|ชั่วโมง|ชม\.|d|days?|天|日|ရက်|ngày|วัน|w|wks?|weeks?|周|週|ပတ်|tuần|สัปดาห์)(?:\s*(?:前|ago|ที่แล้ว|trước|အကြာ))?(?![a-z])/iu;
  const DATE_PARSE_HINT_RE = /\d{4}|\d{1,2}[/:]|\b(?:mon|tue|wed|thu|fri|sat|sun)\b/i;
  const EN_MONTH_DAY_RE =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/i;
  const EN_DAY_MONTH_RE =
    /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;
  function parseRelativePostAge(text: string, now = Date.now(), justNowHours = 0): number | null {
    const raw = normalizeDigits(text)
      .replace(/[·•*。‧・+]/g, ' | ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!raw) return null;
    const cleaned = raw
      .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/gu, '$1')
      .replace(/(\d)\s+(?=[\u4e00-\u9fa5a-z\u1000-\u109f\u0e00-\u0e7f])/gu, '$1')
      .replace(/([\u4e00-\u9fa5])\s+(?=\d)/gu, '$1');
    if (JUST_NOW_RE.test(cleaned)) return justNowHours;
    if (YESTERDAY_RE.test(cleaned)) return 24;
    const todayAge = parseTodayTime(cleaned, now, justNowHours);
    if (todayAge !== null) return todayAge;
    const ymd = YMD_CJK_RE.exec(cleaned);
    if (ymd) {
      const target = new Date(
        Number(ymd[1]),
        Number(ymd[2]) - 1,
        Number(ymd[3]),
        ymd[4] !== undefined ? Number(ymd[4]) : 0,
        ymd[5] !== undefined ? Number(ymd[5]) : 0,
      );
      if (target.getTime() <= now) return Math.max(0, (now - target.getTime()) / 3600000);
    }
    const md = MD_CJK_RE.exec(cleaned);
    if (md) return ageFromMonthDay(Number(md[1]) - 1, Number(md[2]), now);
    const unitMatch = RELATIVE_UNIT_RE.exec(cleaned);
    if (unitMatch) {
      const num = Number(unitMatch[1]);
      const u = unitMatch[2] ?? '';
      if (/^(?:s|sec|秒|စက္ကန့်|giây|วินาที)/iu.test(u)) return num / 3600;
      if (/^(?:m|min|分钟|分鐘|分|မိနစ်|phút|นาที)/iu.test(u)) return num / 60;
      if (/^(?:h|hr|hour|[刂小]|小时|小時|时|時|နာရီ|giờ|ชั่วโมง|ชม)/iu.test(u)) return num;
      return num * (/^(?:w|wk|week|周|週|ပတ်|tuần|สัปดาห์)/iu.test(u) ? 168 : 24);
    }
    if (DATE_PARSE_HINT_RE.test(text)) {
      const parsed = Date.parse(text);
      if (Number.isFinite(parsed) && parsed <= now) return Math.max(0, (now - parsed) / 3600000);
    }
    const en = EN_MONTH_DAY_RE.exec(raw);
    const mIdx = en?.[1] ? EN_MONTHS.indexOf(en[1].slice(0, 3).toLowerCase()) : -1;
    if (mIdx >= 0 && en) return ageFromMonthDay(mIdx, Number(en[2]), now);
    const enDm = EN_DAY_MONTH_RE.exec(raw);
    const dmIdx = enDm?.[2] ? EN_MONTHS.indexOf(enDm[2].slice(0, 3).toLowerCase()) : -1;
    return dmIdx >= 0 && enDm ? ageFromMonthDay(dmIdx, Number(enDm[1]), now) : null;
  }
  function relativePostAge(text: string, now = Date.now()): number | null {
    return parseRelativePostAge(text, now, 0);
  }
  return { parseRelativePostAge, relativePostAge };
}
const defaultAgeParser = createRelativePostAge();
/** Parses multilingual relative/short post timestamps into elapsed hours; used by parseRelativePostAge. */
export const parseRelativePostAge = defaultAgeParser.parseRelativePostAge;
/** Canonical relative post age parser in hours across EN, CJK (SC/TC), TH, VI, MY. */
export const relativePostAge = defaultAgeParser.relativePostAge;
