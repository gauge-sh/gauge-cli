import { createInterface } from "node:readline";
import { CliError } from "./client";

export async function confirmOrAbort(
  question: string,
  yes: boolean | undefined,
): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) {
    throw new CliError(
      "usage",
      "refusing to proceed without confirmation on a non-interactive stdin — pass --yes",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) =>
    rl.question(`${question} [y/N] `, resolve),
  );
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    throw new CliError("usage", "aborted");
  }
}
