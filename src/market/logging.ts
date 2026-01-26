export type WatcherLogWriter = (line: string) => void;
export type WatcherLogger = (...args: unknown[]) => void;

function formatWatcherLogArgs(args: unknown[]): string {
  return args
    .map(arg => {
      if (arg instanceof Error) {
        const stack = arg.stack ? ` | ${arg.stack}` : '';
        return `${arg.name}: ${arg.message}${stack}`;
      }
      if (typeof arg === 'string') return arg;
      if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
      if (arg === null) return 'null';
      if (arg === undefined) return 'undefined';
      try {
        return JSON.stringify(arg);
      } catch {
        return '[Unserializable]';
      }
    })
    .join(' ');
}

const noopLogger: WatcherLogger = () => {};

export function createWatcherLogger(
  writer: WatcherLogWriter | undefined,
  scope?: string
): WatcherLogger {
  if (!writer) {
    return noopLogger;
  }
  return (...args: unknown[]) => {
    const payload = formatWatcherLogArgs(args);
    writer(scope ? `${scope} ${payload}` : payload);
  };
}

export const getWatcherLogger = (log?: WatcherLogger): WatcherLogger => log ?? noopLogger;
