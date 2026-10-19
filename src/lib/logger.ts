const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;
export type Fields = Record<string, unknown>;

const SENSITIVE = /authorization|token|password|secret|cookie|api[-_]?key/i;

function redact(fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = SENSITIVE.test(k) ? '[REDACTED]' : v;
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

export function createLogger(
  level: LogLevel = 'info',
  sink: (line: string) => void = (l) => process.stdout.write(l + '\n'),
): Logger {
  const emit = (lvl: LogLevel, msg: string, fields: Fields = {}) => {
    if (LEVELS[lvl] < LEVELS[level]) return;
    sink(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...redact(fields) }));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}
