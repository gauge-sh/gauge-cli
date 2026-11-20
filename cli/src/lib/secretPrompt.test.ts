import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { readHiddenLine } from "./secretPrompt";

class FakeTty extends PassThrough {
  isTTY = true;
  isRaw = false;
  modes: boolean[] = [];
  setRawMode(mode: boolean) {
    this.isRaw = mode;
    this.modes.push(mode);
    return this;
  }
}

function prompt(...chunks: string[]) {
  const input = new FakeTty();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => {
    written += String(chunk);
  });
  const result = readHiddenLine("Key: ", input, output);
  setImmediate(() => {
    for (const chunk of chunks) input.write(chunk);
  });
  return { result, input, written: () => written };
}

describe("readHiddenLine", () => {
  it("finishes on Enter without echoing, and restores the terminal", async () => {
    const run = prompt("sk-live-", "secret\r");
    assert.equal(await run.result, "sk-live-secret");
    assert.equal(run.written(), "Key: \n");
    assert.deepEqual(run.input.modes, [true, false]);
  });

  it("takes a pasted value with its line ending in one chunk", async () => {
    assert.equal(await prompt("pasted-key\r\n").result, "pasted-key");
    assert.equal(await prompt("pasted-key\n").result, "pasted-key");
  });

  it("edits with Backspace and Ctrl-U, and drops escape sequences", async () => {
    assert.equal(await prompt("abX\x7fc\r").result, "abc");
    assert.equal(await prompt("wrong\x15right\r").result, "right");
    assert.equal(
      await prompt("\x1b[200~key\x1b[201~\x1b[D\r").result,
      "key",
    );
  });

  it("keeps spaces, which a password may contain", async () => {
    assert.equal(await prompt(" pass word \r").result, " pass word ");
  });

  it("finishes on Ctrl-D", async () => {
    assert.equal(await prompt("key\x04").result, "key");
  });

  it("aborts on Ctrl-C and restores the terminal", async () => {
    const run = prompt("partial\x03");
    await assert.rejects(run.result, /aborted/);
    assert.deepEqual(run.input.modes, [true, false]);
    assert.ok(!run.written().includes("partial"));
  });
});
