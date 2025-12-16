// logger.ts
import fs from 'fs';
import path from 'path';

const LOG_DIR = process.env.TMPDIR || '/tmp';
const LOG_PATH = path.join(LOG_DIR, 'bot.log');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

export function logEvent(data: Record<string, any>) {
  try {
    ensureLogDir();

    const line = JSON.stringify(data) + '\n';

    fs.appendFile(LOG_PATH, line, err => {
      if (err) {
        console.error('[LOGGER ERROR]', err);
      }
    });
  } catch (e) {
    console.error('[LOGGER FATAL]', e);
  }
}
