type LogFields = Record<string, unknown>;

function emit(level: string, message: string, fields: LogFields = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const out = level === "error" ? console.error : console.log;
  out(JSON.stringify(line));
}

export const log = {
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
};
