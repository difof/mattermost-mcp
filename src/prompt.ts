// Minimal interactive stdin helpers for the CLI commands (no extra dependency).
// All prompt I/O goes to stderr so that, even when a command's result is piped,
// the prompts stay off stdout. EOF (Ctrl-D / closed stdin) aborts cleanly.
import { createInterface, emitKeypressEvents } from "node:readline";

function onAbort(): never {
  process.stderr.write("\nAborted.\n");
  process.exit(130);
}

/** Ask a question and resolve with the trimmed answer. Aborts on EOF. */
export function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let answered = false;
  return new Promise<string>((resolve) => {
    rl.on("close", () => {
      if (!answered) onAbort();
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });
  });
}

// readline exposes the echo hook as a private method; type it narrowly so we can
// silence keystroke echo without reaching for `any`.
interface MutableReadline {
  _writeToOutput(stringToWrite: string): void;
}

/**
 * Ask for a secret without echoing keystrokes (sudo-style: nothing is shown).
 * The answer is returned verbatim — secrets are not trimmed. Aborts on EOF.
 */
export function promptSecret(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  let answered = false;
  let muted = false;
  (rl as unknown as MutableReadline)._writeToOutput = (stringToWrite) => {
    if (!muted) process.stderr.write(stringToWrite);
  };
  return new Promise<string>((resolve) => {
    rl.on("close", () => {
      if (!answered) onAbort();
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
    // The prompt text has already been written; mute every subsequent keystroke.
    muted = true;
  });
}

// --- Single-select menu (arrow keys) -----------------------------------------

export interface SelectOption<T> {
  value: T;
  label: string;
  hint?: string;
}

interface KeypressInfo {
  name?: string;
  ctrl?: boolean;
}

/** Numbered fallback for non-TTY input (pipes, CI): read a line, parse a number. */
async function selectFallback<T>(title: string, options: SelectOption<T>[]): Promise<T> {
  const list = options
    .map((o, i) => `  ${i + 1}) ${o.label}${o.hint ? `  — ${o.hint}` : ""}`)
    .join("\n");
  process.stderr.write(`${title}\n${list}\n`);
  for (;;) {
    const raw = (await prompt("Choice [1]: ")) || "1";
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!.value;
    process.stderr.write(`  Enter a number between 1 and ${options.length}.\n`);
  }
}

/**
 * Interactive single-select: ↑/↓ (or k/j) to move, digits to jump, Enter to
 * confirm, Ctrl-C / Esc / q to abort. Renders to stderr; falls back to a numbered
 * prompt when stdin/stderr is not a TTY. Resolves with the chosen option's value.
 */
export function select<T>(title: string, options: SelectOption<T>[]): Promise<T> {
  const out = process.stderr;
  const stdin = process.stdin;
  if (!stdin.isTTY || !out.isTTY) return selectFallback(title, options);

  emitKeypressEvents(stdin);
  let index = 0;

  const render = (first: boolean): void => {
    if (!first) out.write(`\x1b[${options.length + 1}A`); // back to the title line
    out.write("\x1b[0J"); // clear from here down
    out.write(`${title}\n`);
    for (const [i, opt] of options.entries()) {
      const active = i === index;
      const pointer = active ? "\x1b[36m›\x1b[0m" : " ";
      const label = active ? `\x1b[36m${opt.label}\x1b[0m` : opt.label;
      const hint = opt.hint ? `  \x1b[2m${opt.hint}\x1b[0m` : "";
      out.write(`${pointer} ${label}${hint}\n`);
    }
  };

  return new Promise<T>((resolve) => {
    const cleanup = (): void => {
      stdin.removeListener("keypress", onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      out.write("\x1b[?25h\n"); // restore cursor + drop below the menu
    };
    const onKey = (str: string | undefined, key: KeypressInfo): void => {
      const name = key?.name ?? "";
      if (key?.ctrl && name === "c") {
        cleanup();
        onAbort();
      } else if (name === "up" || name === "k") {
        index = (index - 1 + options.length) % options.length;
        render(false);
      } else if (name === "down" || name === "j") {
        index = (index + 1) % options.length;
        render(false);
      } else if (str && /^[1-9]$/.test(str) && Number(str) <= options.length) {
        index = Number(str) - 1;
        render(false);
      } else if (name === "return" || name === "enter") {
        cleanup();
        resolve(options[index]!.value);
      } else if (name === "escape" || name === "q") {
        cleanup();
        onAbort();
      }
    };

    out.write("\x1b[?25l"); // hide cursor while navigating
    render(true);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKey);
  });
}
