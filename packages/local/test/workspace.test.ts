import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { preserveWorkspace } from "../src/workspace.js";

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof fs>() }));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await fs.mkdtemp(join(tmpdir(), "workspace-preservation-"));
  roots.push(root);
  const directory = join(root, "session");
  const runtime = join(root, "runtime");
  const source = join(runtime, "workspace/workspace");
  await fs.mkdir(directory);
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(join(source, "edit"), "saved edit");
  await fs.writeFile(join(runtime, "secret"), "credential");
  return { directory, runtime, source };
}
function crossDevice() {
  vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("cross-device"), { code: "EXDEV" }));
}
it("copies across filesystems without following links or copying sibling credentials", async () => {
  const { directory, runtime, source } = await setup();
  const secret = join(runtime, "secret");
  await fs.symlink(secret, join(source, "link"));
  crossDevice();
  expect(await preserveWorkspace(directory, runtime)).toBe("recovered-workspace");
  expect(await fs.readFile(join(directory, "recovered-workspace/edit"), "utf8")).toBe("saved edit");
  expect(await fs.readlink(join(directory, "recovered-workspace/link"))).toBe(secret);
  await expect(fs.lstat(join(directory, "recovered-workspace/secret"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await preserveWorkspace(directory, runtime)).toBe("recovered-workspace");
});
it("keeps the original workspace and credentials on copy failure, allowing a retry", async () => {
  const { directory, runtime, source } = await setup();
  crossDevice();
  vi.spyOn(fs, "cp").mockRejectedValueOnce(new Error("disk full"));
  await expect(preserveWorkspace(directory, runtime)).rejects.toThrow("disk full");
  expect(await fs.readdir(directory)).toEqual([]);
  expect(await fs.readFile(join(source, "edit"), "utf8")).toBe("saved edit");
  expect(await fs.readFile(join(runtime, "secret"), "utf8")).toBe("credential");
  expect(await preserveWorkspace(directory, runtime)).toBe("recovered-workspace");
});
it("refuses a symlink in place of the repository root", async () => {
  const { directory, runtime, source } = await setup();
  await fs.rm(source, { recursive: true });
  await fs.symlink(directory, source);
  await expect(preserveWorkspace(directory, runtime)).rejects.toThrow("Expected a directory");
  expect(await fs.readdir(directory)).toEqual([]);
});
