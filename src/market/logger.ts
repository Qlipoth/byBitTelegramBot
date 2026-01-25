// logger.ts
import fs from 'fs';
import path from 'path';

export class FileLogger {
  private readonly logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
    this.ensureLogDir();
  }

  private ensureLogDir() {
    const dir = path.dirname(this.logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  public log(data: Record<string, unknown>) {
    try {
      const line = JSON.stringify(data) + '\n';
      fs.appendFile(this.logPath, line, err => {
        if (err) {
          console.error('[LOGGER ERROR]', err);
        }
      });
    } catch (e) {
      console.error('[LOGGER FATAL]', e);
    }
  }
}

const tempDir =
  process.env.BOT_LOG_DIR ||
  process.env.TMPDIR ||
  process.env.TEMP ||
  process.env.TMP ||
  (process.platform === 'win32' ? 'C:\\tmp' : '/tmp');
const logFile = process.env.BOT_LOG_FILE ?? path.join(tempDir, 'bot-events.jsonl');
const isFileLoggingEnabled = process.env.BOT_LOG_ENABLED === '1';

const defaultLogger = isFileLoggingEnabled ? new FileLogger(logFile) : null;

export const logEvent = (data: Record<string, unknown>) => {
  if (!isFileLoggingEnabled || !defaultLogger) {
    return;
  }
  defaultLogger.log(data);
};
