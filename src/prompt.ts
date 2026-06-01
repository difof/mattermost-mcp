// Minimal interactive stdin helpers for the CLI commands (no extra dependency).
// All prompt I/O goes to stderr so that, even when a command's result is piped,
// the prompts stay off stdout. EOF (Ctrl-D / closed stdin) aborts cleanly.
import { createInterface } from "node:readline";

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
