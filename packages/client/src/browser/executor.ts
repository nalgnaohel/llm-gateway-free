import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { messagesToPrompt, type ChatMessage } from "@aigw/shared";
import { WEB_PROVIDERS, knownProviderIds, type WebProvider } from "./providers.ts";
import {
  POLL_INTERVAL_MS,
  START_TIMEOUT_MS,
  StallWatchdog,
  deltaOf,
  hasTurnStarted,
  isTransientText,
  isTurnSettled,
  type TurnState,
} from "./settle.ts";
import { logger } from "../log.ts";

const log = logger("browser");

export type BrowserExecutorOptions = {
  cdpUrl: string;
  allowProviders: string[];
  autoOpenTab: boolean;
};

export type ProbeResult = { providerId: string; available: boolean; reason?: string };

export class BrowserExecutor {
  private browser?: Browser;
  private readonly opts: BrowserExecutorOptions;

  constructor(opts: BrowserExecutorOptions) {
    this.opts = opts;
  }

  providerIds(): string[] {
    const all = knownProviderIds();
    if (this.opts.allowProviders.length === 0) return all;
    return all.filter((id) => this.opts.allowProviders.includes(id));
  }

  /** Attach to an already-running Chrome over CDP. Never launches a browser. */
  private async connect(): Promise<Browser | undefined> {
    if (this.browser?.isConnected()) return this.browser;
    try {
      const browser = await chromium.connectOverCDP(this.opts.cdpUrl, { timeout: 5_000 });
      // Dropping our websocket must never close the user's Chrome.
      browser.on("disconnected", () => {
        this.browser = undefined;
      });
      this.browser = browser;
      return browser;
    } catch (err) {
      log.debug(`CDP connect failed: ${String(err)}`);
      this.browser = undefined;
      return undefined;
    }
  }

  private contexts(browser: Browser): BrowserContext[] {
    return browser.contexts();
  }

  private findPage(browser: Browser, provider: WebProvider): Page | undefined {
    for (const ctx of this.contexts(browser)) {
      for (const page of ctx.pages()) {
        if (page.isClosed()) continue;
        let host = "";
        try {
          host = new URL(page.url()).host;
        } catch {
          continue;
        }
        if (host.includes(provider.origin)) return page;
      }
    }
    return undefined;
  }

  /** Which providers currently have a usable tab. Cheap; runs on a timer. */
  async probe(): Promise<ProbeResult[]> {
    const browser = await this.connect();
    const ids = this.providerIds();
    if (!browser) {
      return ids.map((providerId) => ({ providerId, available: false, reason: `no Chrome on ${this.opts.cdpUrl}` }));
    }
    const out: ProbeResult[] = [];
    for (const id of ids) {
      const provider = WEB_PROVIDERS[id];
      const page = this.findPage(browser, provider);
      if (!page) {
        out.push({ providerId: id, available: false, reason: "no open tab for this provider" });
        continue;
      }
      try {
        const composer = await page.locator(provider.selectors.composer).first().count();
        if (composer === 0) {
          out.push({ providerId: id, available: false, reason: "composer not found (signed out or UI changed)" });
          continue;
        }
        if (provider.selectors.signedOut) {
          const signedOut = await page.locator(provider.selectors.signedOut).first().count();
          if (signedOut > 0) {
            out.push({ providerId: id, available: false, reason: "signed out" });
            continue;
          }
        }
        out.push({ providerId: id, available: true });
      } catch (err) {
        out.push({ providerId: id, available: false, reason: `probe error: ${String(err)}` });
      }
    }
    return out;
  }

  async run(args: {
    providerId: string;
    messages: ChatMessage[];
    timeoutMs: number;
    signal: AbortSignal;
    onDelta: (delta: string) => void;
  }): Promise<{ content: string }> {
    const provider = WEB_PROVIDERS[args.providerId];
    if (!provider) throw new Error(`unknown web provider "${args.providerId}"`);

    const browser = await this.connect();
    if (!browser) throw new Error(`cannot reach Chrome at ${this.opts.cdpUrl} — start it with --remote-debugging-port`);

    let page = this.findPage(browser, provider);
    if (!page) {
      if (!this.opts.autoOpenTab) throw new Error(`no open tab for ${provider.displayName}`);
      const ctx = this.contexts(browser)[0] ?? (await browser.newContext());
      page = await ctx.newPage();
      await page.goto(provider.defaultUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.locator(provider.selectors.composer).first().waitFor({ timeout: 30_000 });
    }

    const prompt = messagesToPrompt(args.messages);
    const baseline = await this.snapshot(page, provider);
    await this.inject(page, provider, prompt);
    return this.awaitReply(page, provider, baseline, args);
  }

  /* -------------------------------------------------------------- internals */

  private async snapshot(page: Page, provider: WebProvider): Promise<{ count: number; text: string }> {
    const nodes = page.locator(provider.selectors.assistant);
    const count = await nodes.count().catch(() => 0);
    const text = count > 0 ? ((await nodes.last().innerText().catch(() => "")) ?? "") : "";
    return { count, text: text.trim() };
  }

  private async isStreaming(page: Page, provider: WebProvider): Promise<boolean> {
    if (!provider.selectors.stop) return false;
    try {
      return (await page.locator(provider.selectors.stop).first().isVisible({ timeout: 200 })) === true;
    } catch {
      return false;
    }
  }

  /** Type the prompt and submit, retrying while the composer refuses to clear. */
  private async inject(page: Page, provider: WebProvider, text: string): Promise<void> {
    const composer = page.locator(provider.selectors.composer).first();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Never send on top of an in-flight answer.
      await this.waitIdle(page, provider, 15_000);
      await composer.click({ timeout: 10_000 });
      if (provider.contentEditable) {
        await composer.fill("").catch(() => {});
        await composer.type(text, { delay: 0 });
        // React/Slate composers only register content on a synthetic input event.
        await composer.dispatchEvent("input").catch(() => {});
      } else {
        await composer.fill(text);
      }
      await this.submit(page, provider);
      if (await this.composerCleared(page, provider)) return;
      if (await this.isStreaming(page, provider)) return; // landed even if slow to clear
      log.warn(`${provider.id}: composer did not clear (attempt ${attempt + 1})`);
    }
    throw new Error(`${provider.displayName}: composer never cleared after 3 send attempts`);
  }

  private async submit(page: Page, provider: WebProvider): Promise<void> {
    if (provider.selectors.send) {
      const btn = page.locator(provider.selectors.send).first();
      if ((await btn.count()) > 0 && (await btn.isEnabled().catch(() => false))) {
        await btn.click({ timeout: 5_000 }).catch(() => {});
        return;
      }
    }
    // Enter mid-stream can interrupt generation; only press when idle.
    if (!(await this.isStreaming(page, provider))) await page.keyboard.press("Enter");
  }

  private async composerCleared(page: Page, provider: WebProvider): Promise<boolean> {
    const composer = page.locator(provider.selectors.composer).first();
    for (let i = 0; i < 12; i += 1) {
      const value = await composer
        .evaluate((el: { value?: unknown; textContent?: string | null }) =>
          typeof el.value === "string" ? el.value : (el.textContent ?? ""),
        )
        .catch(() => "");
      if (value.trim().length === 0) return true;
      await page.waitForTimeout(300);
    }
    return false;
  }

  /** Two consecutive clear polls, so a flicker between phases never reads as idle. */
  private async waitIdle(page: Page, provider: WebProvider, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let clear = 0;
    while (Date.now() < deadline) {
      if (await this.isStreaming(page, provider)) clear = 0;
      else if (++clear >= 2) return;
      await page.waitForTimeout(POLL_INTERVAL_MS);
    }
  }

  private async awaitReply(
    page: Page,
    provider: WebProvider,
    baseline: { count: number; text: string },
    args: { timeoutMs: number; signal: AbortSignal; onDelta: (delta: string) => void },
  ): Promise<{ content: string }> {
    const deadline = Date.now() + args.timeoutMs;
    const watchdog = new StallWatchdog();
    let lastText = "";
    let lastChangeAt = Date.now();
    let emitted = "";
    let started = false;
    let startDeadline = Date.now() + Math.min(START_TIMEOUT_MS, args.timeoutMs);

    while (Date.now() < deadline) {
      if (args.signal.aborted) throw new Error("cancelled");

      const streaming = await this.isStreaming(page, provider);
      const snap = await this.snapshot(page, provider);
      const state: TurnState = {
        streaming,
        text: snap.text,
        stableForMs: Date.now() - lastChangeAt,
        assistantCount: snap.count,
        baselineAssistantCount: baseline.count,
        baselineText: baseline.text,
      };

      if (snap.text !== lastText) {
        lastText = snap.text;
        lastChangeAt = Date.now();
        watchdog.noteProgress();
      }

      if (!started && hasTurnStarted(state)) {
        started = true;
        watchdog.noteProgress();
      }
      if (!started && Date.now() > startDeadline) {
        throw new Error(`${provider.displayName}: no response started within ${Math.round((startDeadline - (deadline - args.timeoutMs)) / 1000)}s`);
      }

      if (started) {
        if (isTransientText(snap.text)) {
          // "Thinking…" is a placeholder the UI will wipe. Emitting it would
          // poison the delta baseline, since the real answer is not a suffix of it.
          emitted = "";
        } else {
          const delta = deltaOf(emitted, snap.text);
          if (delta) {
            emitted = snap.text;
            args.onDelta(delta);
          } else if (snap.text && !snap.text.startsWith(emitted)) {
            // The node was rewritten in place (markdown re-render, citations).
            // Resync quietly; job.done carries the authoritative full text.
            emitted = snap.text;
          }
        }
      }

      if (isTurnSettled({ ...state, stableForMs: Date.now() - lastChangeAt })) {
        return { content: snap.text };
      }

      if (watchdog.shouldReload()) {
        const n = watchdog.noteReload();
        log.warn(`${provider.id}: render stalled — reloading tab (reload ${n})`);
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        await page.locator(provider.selectors.composer).first().waitFor({ timeout: 30_000 }).catch(() => {});
        lastText = "";
        lastChangeAt = Date.now();
        startDeadline = Date.now() + Math.min(START_TIMEOUT_MS, deadline - Date.now());
      }

      await page.waitForTimeout(POLL_INTERVAL_MS);
    }

    if (lastText) return { content: lastText };
    throw new Error(`${provider.displayName}: timed out after ${args.timeoutMs}ms with no reply`);
  }

  async dispose(): Promise<void> {
    // Detach only. Do not call browser.close() — it would kill the user's Chrome.
    this.browser = undefined;
  }
}
