import { CliError } from "./client";

/** The parts of a TTY stream the prompt uses, so tests can supply a fake. */
export type HiddenInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode(mode: boolean): unknown;
};

// CSI sequences (arrow keys, bracketed-paste markers) and other ESC-prefixed
// keys. None of them is part of a secret.
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])/g;

/**
 * Read one line from a terminal without echoing it. Enter (or Ctrl-D) submits,
 * Backspace and Ctrl-U edit, and Ctrl-C aborts. Nothing typed or pasted is
 * written anywhere, not even as masking characters, so neither the value nor
 * its length is left on screen or in a captured transcript.
 */
export function readHiddenLine(
  prompt: string,
  input: HiddenInput = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<string> {
  output.write(prompt);
  const wasRaw = input.isRaw ?? false;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: CliError) => {
      input.removeListener("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string | Buffer) => {
      const text = String(chunk).replace(ESCAPE_SEQUENCE, "");
      for (const ch of text) {
        if (ch === "\r" || ch === "\n" || ch === "\x04") return finish();
        if (ch === "\x03") return finish(new CliError("usage", "aborted"));
        if (ch === "\x7f" || ch === "\b") {
          value = Array.from(value).slice(0, -1).join("");
        } else if (ch === "\x15") {
          value = "";
        } else if (ch >= " ") {
          value += ch;
        }
      }
    };
    input.on("data", onData);
  });
}
