/**
 * Structured logging. One JSON object per line so the output pipes straight
 * into any log shipper, plus a human-readable mode for local development
 * (`ROYALE_LOG=pretty`). Never logs hole cards — see `server/README.md`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const ANSI: Record<LogLevel, string> = {
  debug: '[38;5;244m',
  info: '[38;5;80m',
  warn: '[38;5;214m',
  error: '[38;5;203m',
};
const DIM = '[38;5;240m';
const RESET = '[0m';

export interface LoggerOptions {
  level?: LogLevel;
  pretty?: boolean;
  /** static fields merged into every line (service name, table id, …) */
  base?: Record<string, unknown>;
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(base: Record<string, unknown>): Logger;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const min = LEVEL_ORDER[opts.level ?? 'info'];
  const pretty = opts.pretty ?? false;
  const base = opts.base ?? {};

  const write = (level: LogLevel, event: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < min) return;
    const ts = Date.now();
    if (pretty) {
      let line = `${DIM}${clock(ts)}${RESET} ${ANSI[level]}${level.toUpperCase().padEnd(5)}${RESET} ${event}`;
      const merged = { ...base, ...fields };
      const parts: string[] = [];
      for (const k of Object.keys(merged)) {
        if (merged[k] === undefined) continue;
        const v = merged[k];
        parts.push(`${DIM}${k}${RESET}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
      }
      if (parts.length) line += `  ${parts.join(' ')}`;
      // eslint-disable-next-line no-console
      console.log(line);
      return;
    }
    const payload: Record<string, unknown> = { ts, level, event, ...base, ...fields };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload));
  };

  const make = (b: Record<string, unknown>): Logger => ({
    debug: (e, f) => write('debug', e, { ...b, ...f }),
    info: (e, f) => write('info', e, { ...b, ...f }),
    warn: (e, f) => write('warn', e, { ...b, ...f }),
    error: (e, f) => write('error', e, { ...b, ...f }),
    child: (extra) => make({ ...b, ...extra }),
  });

  return make({});
}

/** A logger that swallows everything — handy in tests. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
