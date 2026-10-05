/** One foreground row; redirects remain ordinary logs and input keeps its own screen. */
const reporters = new WeakMap<NodeJS.WritableStream, ForegroundProgress>();
const FRAMES = ["|", "/", "-", "\\"] as const;

export type SetupForeground = "install" | "update" | "onboard";

export class ForegroundProgress {
  private timer: ReturnType<typeof setInterval> | undefined;
  private label = "";
  private width = 0;
  private frame = 0;
  private paused = 0;
  private generation = 0;
  private started = 0;

  constructor(
    private readonly stream: NodeJS.WritableStream,
    stderr: NodeJS.WritableStream,
    private readonly interactive: boolean,
  ) {
    reporters.set(stream, this);
    reporters.set(stderr, this);
  }

  start(label: string): () => void {
    this.stop();
    this.label = plainLabel(label);
    this.started = Date.now();
    const generation = ++this.generation;
    if (this.interactive) this.animate();
    else this.stream.write(`${this.label}\n`);
    return () => {
      if (generation === this.generation) this.stop();
    };
  }

  clear(): void {
    if (!this.width) return;
    this.stream.write(`\r${" ".repeat(this.width)}\r`);
    this.width = 0;
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.label = "";
    this.clear();
  }

  pause(): () => void {
    this.paused++;
    this.clear();
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.paused--;
    };
  }

  private animate(): void {
    this.draw();
    this.timer = setInterval(() => this.draw(), 160);
    this.timer.unref();
  }

  private draw(): void {
    if (this.paused || !this.label) return;
    const columns = (this.stream as NodeJS.WriteStream).columns || 80;
    const seconds = Math.floor((Date.now() - this.started) / 1000);
    const elapsed = seconds >= 3 ? ` (${seconds}s)` : "";
    const row = `${FRAMES[this.frame++ % FRAMES.length]} ${this.label}${elapsed}`.slice(
      0,
      Math.max(1, columns - 1),
    );
    this.stream.write(`\r${row}${" ".repeat(Math.max(0, this.width - row.length))}`);
    this.width = row.length;
  }
}

function plainLabel(text: string): string {
  return [...text].map((character) => (character.codePointAt(0)! < 32 ? " " : character)).join("");
}

/** Nested prompts/provider commands pause the linked stdout/stderr reporter. */
export function pauseSetupProgress(stream: NodeJS.WritableStream = process.stderr): () => void {
  return reporters.get(stream)?.pause() ?? (() => {});
}

/** The CLI's outer error handler creates a fresh Output for the same terminal. */
export function stopSetupProgress(stream: NodeJS.WritableStream): void {
  reporters.get(stream)?.stop();
}
