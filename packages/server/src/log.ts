const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
let threshold = LEVELS.info;

export function setLogLevel(level: string): void {
  threshold = LEVELS[level] ?? LEVELS.info;
}

function emit(level: string, scope: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const sink = level === "error" || level === "warn" ? console.error : console.log;
  if (extra === undefined) sink(line);
  else sink(line, typeof extra === "string" ? extra : JSON.stringify(extra));
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit("debug", scope, m, e),
    info: (m: string, e?: unknown) => emit("info", scope, m, e),
    warn: (m: string, e?: unknown) => emit("warn", scope, m, e),
    error: (m: string, e?: unknown) => emit("error", scope, m, e),
  };
}
