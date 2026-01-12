import { promises as fs } from 'node:fs';
import path from 'node:path';
import dayjs from 'dayjs';

import { preloadMarketSnapshots } from '../src/services/bybit.js';
import { parseMonthSelections } from '../src/backtest/monthSelection.js';
import { DEFAULT_SNAPSHOT_FILE, SYMBOL_HISTORY_FILES } from '../src/market/snapshotStore.js';

type CliOptions = {
  symbol: string;
  months: string[];
  outFile: string;
};

function normalizeSymbol(raw: string): string {
  const upper = raw.toUpperCase();
  return upper.endsWith('USDT') ? upper : `${upper}USDT`;
}

const HISTORY_SYMBOL_SET = new Set(Object.keys(SYMBOL_HISTORY_FILES));

function resolveSnapshotTarget(symbol: string, customPath?: string): string {
  if (customPath) {
    return path.resolve(customPath);
  }
  if (HISTORY_SYMBOL_SET.has(symbol)) {
    return SYMBOL_HISTORY_FILES[symbol as keyof typeof SYMBOL_HISTORY_FILES];
  }
  return DEFAULT_SNAPSHOT_FILE;
}

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  if (!args.length) {
    throw new Error(
      'Usage: pnpm preload:months <SYMBOL> <month1> <month2> ... [--out path/to/file.jsonl]'
    );
  }

  const rawSymbol = args[0]!;
  const symbol = normalizeSymbol(rawSymbol);
  const months: string[] = [];
  let outFile: string | undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--out') {
      const explicitPath = args[i + 1];
      if (!explicitPath) {
        throw new Error('--out flag requires a file path');
      }
      outFile = explicitPath;
      i++;
      continue;
    }
    months.push(arg);
  }

  if (!months.length) {
    throw new Error('Please provide at least one month token, e.g. nov-2025');
  }

  if (!outFile) {
    const safeSymbol = symbol.replace(/[^a-z0-9]/gi, '_').toUpperCase();
    outFile = path.join('C:\\tmp', `SNAPS_${safeSymbol}.jsonl`);
  }

  return {
    symbol,
    months,
    outFile,
  };
}

async function appendSnapshots(filePath: string, snapshots: any[]): Promise<void> {
  if (!snapshots.length) return;
  const payload = snapshots.map(s => JSON.stringify(s)).join('\n') + '\n';
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, payload, 'utf-8');
}

async function main() {
  const options = parseCliArgs();
  const monthSelections = parseMonthSelections(options.months);

  if (!monthSelections || !monthSelections.length) {
    throw new Error('Invalid month tokens provided');
  }

  const targetFile = resolveSnapshotTarget(options.symbol, options.outFile);
  console.log(
    `🗂️  Writing snapshots for ${options.symbol} to ${targetFile}\n` +
      `Months: ${monthSelections.map(sel => sel.label).join(', ')}`
  );

  for (const selection of monthSelections) {
    console.log(
      `\n📅 ${selection.label} → ${dayjs(selection.startTime).toISOString()} - ${dayjs(
        selection.endTime
      ).toISOString()}`
    );
    const snapshots = await preloadMarketSnapshots(options.symbol, {
      startTime: selection.startTime,
      endTime: selection.endTime,
    });
    await appendSnapshots(targetFile, snapshots);
    console.log(`✅ ${selection.label}: appended ${snapshots.length} snapshots (${targetFile})`);
  }

  console.log('\n🎉 Completed snapshot preloading.');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ preload failed:', err.message ?? err);
    process.exit(1);
  });
