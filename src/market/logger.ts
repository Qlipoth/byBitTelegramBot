// logger.ts
import fs from 'fs';
import path from 'path';

export class FileLogger {
  private readonly logDir: string;
  private readonly logPath: string;

  constructor(logDir: string = process.env.TMPDIR || '/tmp', fileName: string = 'bot.log') {
    this.logDir = logDir;
    this.logPath = path.join(this.logDir, fileName);
    this.ensureLogDir();
  }

  private ensureLogDir() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
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

const defaultLogger = new FileLogger();
export const logEvent = (data: Record<string, unknown>) => defaultLogger.log(data);
