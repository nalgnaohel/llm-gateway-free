/**
 * Pure completion-detection logic, kept free of Playwright so it is unit-testable.
 *
 * A web chat turn is "settled" when: the stop control is gone, the assistant text
 * has stopped changing for a quiet window, and the text is not a transient
 * placeholder ("Thinking…"). A stall watchdog bounds the wait when a UI hangs.
 */

export const SETTLE_QUIET_MS = 1_200;
export const POLL_INTERVAL_MS = 300;
export const START_TIMEOUT_MS = 60_000;
export const STALL_RELOAD_MS = 180_000;
export const MAX_STALL_RELOADS = 2;

const TRANSIENT = [
  /^thinking\.*…?$/i,
  /^thought for .*$/i,
  /^generating response\.*…?$/i,
  /^analyzing\.*…?$/i,
  /^\s*$/,
];

export function isTransientText(text: string): boolean {
  const t = text.trim();
  return TRANSIENT.some((re) => re.test(t));
}

export type TurnState = {
  /** stop button visible */
  streaming: boolean;
  /** current text of the last assistant node */
  text: string;
  /** how long `text` has been unchanged, ms */
  stableForMs: number;
  /** assistant node count now vs. before the prompt was sent */
  assistantCount: number;
  baselineAssistantCount: number;
  /** text of the last assistant node before the prompt was sent */
  baselineText: string;
};

/** Has the provider begun answering this turn at all? */
export function hasTurnStarted(s: TurnState): boolean {
  if (s.streaming) return true;
  if (s.assistantCount > s.baselineAssistantCount) return true;
  return s.text.length > 0 && s.text !== s.baselineText;
}

export function isTurnSettled(s: TurnState): boolean {
  if (s.streaming) return false;
  if (!hasTurnStarted(s)) return false;
  if (s.stableForMs < SETTLE_QUIET_MS) return false;
  if (isTransientText(s.text)) return false;
  return s.text.length > 0;
}

/**
 * Reload-on-stall guard. `noteProgress()` on every observed change; `shouldReload()`
 * turns true once nothing has moved for `stallMs`, at most `maxReloads` times.
 */
export class StallWatchdog {
  private lastProgressAt: number;
  private reloads = 0;
  private readonly stallMs: number;
  private readonly maxReloads: number;
  private readonly clock: () => number;

  constructor(opts?: { stallMs?: number; maxReloads?: number; clock?: () => number }) {
    this.stallMs = opts?.stallMs ?? STALL_RELOAD_MS;
    this.maxReloads = opts?.maxReloads ?? MAX_STALL_RELOADS;
    this.clock = opts?.clock ?? Date.now;
    this.lastProgressAt = this.clock();
  }

  noteProgress(): void {
    this.lastProgressAt = this.clock();
  }

  shouldReload(): boolean {
    if (this.reloads >= this.maxReloads) return false;
    return this.clock() - this.lastProgressAt >= this.stallMs;
  }

  noteReload(): number {
    this.reloads += 1;
    this.lastProgressAt = this.clock();
    return this.reloads;
  }

  get reloadCount(): number {
    return this.reloads;
  }
}

/** Deltas to stream: what is new in `next` relative to `previous`. */
export function deltaOf(previous: string, next: string): string {
  if (next.startsWith(previous)) return next.slice(previous.length);
  // The UI rewrote the node (markdown re-render, citation insertion). The safest
  // contract for the gateway is to resend nothing here and let the final
  // job.done carry the authoritative text.
  return "";
}
