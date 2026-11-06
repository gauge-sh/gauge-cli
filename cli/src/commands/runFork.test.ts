import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forkBody } from "./runFork";

const url = "https://docs.example.com/start";

describe("forkBody", () => {
  it("forks before a seq, with or without a new message", () => {
    assert.deepEqual(forkBody({ before: "34" }), {
      kind: "run_again",
      beforeSeq: 34,
    });
    assert.deepEqual(forkBody({ before: "12", message: "Use staging" }), {
      kind: "new_message",
      beforeSeq: 12,
      message: "Use staging",
    });
    for (const bad of ["0", "-1", "1.5", "x"])
      assert.throws(() => forkBody({ before: bad }), /--before takes/);
    assert.throws(() => forkBody({}), /pass --before/);
  });

  it("mocks a page with edits or a whole body", () => {
    const files: Record<string, string> = {
      "edits.json": '[{"find":"a","replace":"b"}]',
      "page.html": "<h1>New</h1>",
    };
    const read = (path: string) => files[path];
    assert.deepEqual(forkBody({ page: url, edits: "edits.json" }, read), {
      kind: "mock_page",
      url,
      edits: [{ find: "a", replace: "b" }],
    });
    assert.deepEqual(
      forkBody(
        { page: url, from: "page.html", contentType: "text/html" },
        read,
      ),
      { kind: "mock_page", url, body: "<h1>New</h1>", contentType: "text/html" },
    );
  });

  it("rejects mixed flags", () => {
    assert.throws(() => forkBody({ page: url }), /--edits <file> or --from/);
    assert.throws(
      () => forkBody({ page: url, edits: "a", from: "b" }),
      /--edits <file> or --from/,
    );
    assert.throws(
      () => forkBody({ page: url, before: "3", edits: "a" }),
      /drop --before/,
    );
    assert.throws(() => forkBody({ before: "3", edits: "a" }), /need --page/);
    assert.throws(
      () => forkBody({ page: url, edits: "a", contentType: "text/html" }),
      /only applies with --from/,
    );
  });
});
