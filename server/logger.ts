type LogContext = Record<string, unknown>;

const sensitiveKeyPattern = /(token|secret|password|authorization|cookie|api[-_]?key|cpf|document|email|phone)/i;

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, sensitiveKeyPattern.test(key) ? "[REDACTED]" : sanitize(nested)]));
}

function write(level: "INFO" | "WARN" | "ERROR", message: string, context: LogContext = {}) {
  const sanitizedContext = sanitize(context) as Record<string, unknown>;
  const entry = { timestamp: new Date().toISOString(), level, service: "tgr-crm", message, ...sanitizedContext };
  const output = JSON.stringify(entry);
  if (level === "ERROR") console.error(output);
  else if (level === "WARN") console.warn(output);
  else console.log(output);
}

export const logger = {
  info: (message: string, context?: LogContext) => write("INFO", message, context),
  warn: (message: string, context?: LogContext) => write("WARN", message, context),
  error: (message: string, context?: LogContext) => write("ERROR", message, context),
};
