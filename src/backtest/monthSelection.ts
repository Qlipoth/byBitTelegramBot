import dayjs from 'dayjs';

export type MonthSelection = {
  token: string;
  startTime: number;
  endTime: number;
  label: string;
};

const MONTH_ALIAS_GROUPS = [
  { num: 1, aliases: ['jan', 'january', 'янв', 'январь', '1', '01'] },
  { num: 2, aliases: ['feb', 'february', 'фев', 'февраль', '2', '02'] },
  { num: 3, aliases: ['mar', 'march', 'мар', 'март', '3', '03'] },
  { num: 4, aliases: ['apr', 'april', 'апр', 'апрель', '4', '04'] },
  { num: 5, aliases: ['may', 'май', '5', '05'] },
  { num: 6, aliases: ['jun', 'june', 'июн', 'июнь', '6', '06'] },
  { num: 7, aliases: ['jul', 'july', 'июл', 'июль', '7', '07'] },
  { num: 8, aliases: ['aug', 'august', 'авг', 'август', '8', '08'] },
  { num: 9, aliases: ['sep', 'sept', 'september', 'сен', 'сент', 'сентябрь', '9', '09'] },
  { num: 10, aliases: ['oct', 'october', 'окт', 'октябрь', '10'] },
  { num: 11, aliases: ['nov', 'november', 'ноя', 'нояб', 'ноябрь', '11', 'nv'] },
  { num: 12, aliases: ['dec', 'december', 'дек', 'декабрь', '12'] },
] as const;

const MONTH_ALIAS_MAP = new Map<string, number>();
for (const { num, aliases } of MONTH_ALIAS_GROUPS) {
  for (const alias of aliases) {
    MONTH_ALIAS_MAP.set(alias.toLowerCase(), num);
  }
}

export function tryParseMonthToken(token: string | undefined): MonthSelection | null {
  if (!token) return null;
  const cleaned = token.trim().toLowerCase();
  const match = cleaned.match(/^([a-zа-яё]+|\d{1,2})(?:[-_/](\d{4}))?$/i);
  if (!match) return null;
  const [, monthPartRaw, yearRaw] = match;
  const monthPart = monthPartRaw!.toLowerCase();
  const monthNumber = MONTH_ALIAS_MAP.get(monthPart);
  if (!monthNumber) return null;
  const now = dayjs();
  let year = yearRaw ? Number(yearRaw) : now.year();
  if (!Number.isFinite(year) || year < 1970) return null;
  const startTime = dayjs()
    .year(year)
    .month(monthNumber - 1)
    .startOf('month')
    .valueOf();

  // If start time is in the future and year wasn't explicitly provided, assume previous year.
  if (!yearRaw && startTime > now.valueOf()) {
    year -= 1;
  }

  const finalStart = dayjs()
    .year(year)
    .month(monthNumber - 1)
    .startOf('month')
    .valueOf();
  const endTime = dayjs(finalStart).endOf('month').valueOf();
  return {
    token,
    startTime: finalStart,
    endTime,
    label: dayjs(finalStart).format('MMMM YYYY'),
  };
}

export function parseMonthSelections(tokens: string[]): MonthSelection[] | null {
  if (!tokens.length) return [];
  const selections: MonthSelection[] = [];
  for (const token of tokens) {
    const parsed = tryParseMonthToken(token);
    if (!parsed) {
      return null;
    }
    selections.push(parsed);
  }
  return selections;
}
