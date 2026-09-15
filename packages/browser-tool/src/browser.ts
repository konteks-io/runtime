import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { RemoteInstanceError } from "@konteks/remote-common";
import { decideNavigation, type BrowserToolPolicy } from "./policy.js";

/**
 * Headless Chromium sessions, one isolated context per tool session. The
 * launch path comes from the image (`PLAYWRIGHT_CHROMIUM_EXECUTABLE`), never
 * downloaded at runtime.
 */
export interface BrowserSessionOptions {
  policy: BrowserToolPolicy;
  executablePath?: string;
}

export interface SnapshotResult {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

export class BrowserSessions {
  private browser: Browser | null = null;
  private readonly contexts = new Map<string, { context: BrowserContext; page: Page; lastUsedAt: number }>();

  constructor(private readonly options: BrowserSessionOptions) {}

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = await chromium.launch({
      headless: true,
      ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    return this.browser;
  }

  async page(sessionId: string): Promise<Page> {
    const existing = this.contexts.get(sessionId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.page;
    }
    if (this.contexts.size >= this.options.policy.maxContexts) {
      const oldest = [...this.contexts.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
      if (oldest) await this.close(oldest[0]);
    }
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    this.contexts.set(sessionId, { context, page, lastUsedAt: Date.now() });
    return page;
  }

  async navigate(sessionId: string, target: string): Promise<SnapshotResult> {
    const decision = decideNavigation(this.options.policy, target);
    if (!decision.ok) throw new RemoteInstanceError("preview_path_invalid", `navigation refused: ${decision.reason}`);
    const page = await this.page(sessionId);
    await page.goto(decision.url.toString(), { timeout: this.options.policy.navigationTimeoutMs, waitUntil: "domcontentloaded" });
    return this.snapshot(sessionId);
  }

  async snapshot(sessionId: string): Promise<SnapshotResult> {
    const page = await this.page(sessionId);
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    const max = this.options.policy.maxSnapshotChars;
    return { url: page.url(), title: await page.title(), text: text.slice(0, max), truncated: text.length > max };
  }

  async click(sessionId: string, selector: string): Promise<SnapshotResult> {
    const page = await this.page(sessionId);
    await page.click(selector, { timeout: this.options.policy.navigationTimeoutMs });
    return this.snapshot(sessionId);
  }

  async type(sessionId: string, selector: string, text: string, submit: boolean): Promise<SnapshotResult> {
    const page = await this.page(sessionId);
    await page.fill(selector, text, { timeout: this.options.policy.navigationTimeoutMs });
    if (submit) await page.press(selector, "Enter");
    return this.snapshot(sessionId);
  }

  async waitFor(sessionId: string, selector: string): Promise<SnapshotResult> {
    const page = await this.page(sessionId);
    await page.waitForSelector(selector, { timeout: this.options.policy.navigationTimeoutMs });
    return this.snapshot(sessionId);
  }

  async screenshot(sessionId: string): Promise<{ base64: string; bytes: number }> {
    const page = await this.page(sessionId);
    const buffer = await page.screenshot({ type: "png", fullPage: false });
    if (buffer.byteLength > this.options.policy.maxScreenshotBytes) {
      throw new RemoteInstanceError("temporarily_unavailable", "screenshot exceeds the size cap");
    }
    return { base64: buffer.toString("base64"), bytes: buffer.byteLength };
  }

  async close(sessionId: string): Promise<void> {
    const entry = this.contexts.get(sessionId);
    if (!entry) return;
    this.contexts.delete(sessionId);
    await entry.context.close().catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.contexts.keys()]) await this.close(id);
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }

  activeContexts(): number {
    return this.contexts.size;
  }
}
