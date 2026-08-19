const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
let threshold = LEVELS.info;

export function setLogLevel(level: string): void {
  threshold = LEVELS[level] ?? LEVELS.info;
}

export function logger(scope: string) {
  const emit = (level: string, msg: string, extra?: unknown) => {
    if (LEVELS[level] < threshold) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    const sink = level === "error" || level === "warn" ? console.error : console.log;
    if (extra === undefined) sink(line);
    else sink(line, typeof extra === "string" ? extra : JSON.stringify(extra));
  };
  return {
    debug: (m: string, e?: unknown) => emit("debug", m, e),
    info: (m: string, e?: unknown) => emit("info", m, e),
    warn: (m: string, e?: unknown) => emit("warn", m, e),
    error: (m: string, e?: unknown) => emit("error", m, e),
  };
}
