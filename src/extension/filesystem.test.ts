import { mkdtemp, mkdir, readFile, symlink, writeFile as writeNode, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listFiles, removeFile, renameFile, writeFile } from "./filesystem.js";

const file = (relative: string, text = "ok") => ({ path: relative, contentHash: "h", size: text.length, mode: "file" as const, content: new TextEncoder().encode(text) });

async function workspace(): Promise<{ root: string; outside: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "rulesync-fs-"));
  const outside = path.join(root, "..", `${path.basename(root)}-outside.txt`);
  await writeNode(outside, "sentinel");
  return { root, outside, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { force: true }); } };
}

describe("filesystem containment", () => {
  it("writes, lists, renames, and deletes only under .cursor", async () => {
    const { root, cleanup } = await workspace();
    try {
      await writeFile(root, file(".cursor/rules/team.mdc", "team"));
      await expect(listFiles(root)).resolves.toMatchObject([{ path: ".cursor/rules/team.mdc" }]);
      await renameFile(root, ".cursor/rules/team.mdc", ".cursor/rules/next.mdc");
      await expect(listFiles(root)).resolves.toMatchObject([{ path: ".cursor/rules/next.mdc" }]);
      await removeFile(root, ".cursor/rules/next.mdc");
      await expect(listFiles(root)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });

  it("rejects a .cursor symlink and leaves the outside sentinel alone", async () => {
    const { root, outside, cleanup } = await workspace();
    try {
      await symlink(path.dirname(outside), path.join(root, ".cursor"));
      await expect(listFiles(root)).rejects.toThrow(/Symlinks/);
      await expect(writeFile(root, file(".cursor/rules/team.mdc"))).rejects.toThrow(/Symlinks/);
      expect(await readFile(outside, "utf8")).toBe("sentinel");
    } finally { await cleanup(); }
  });

  it("rejects nested parent and target symlinks", async () => {
    const { root, outside, cleanup } = await workspace();
    try {
      await mkdir(path.join(root, ".cursor"), { recursive: true });
      await symlink(path.dirname(outside), path.join(root, ".cursor", "rules"));
      await expect(writeFile(root, file(".cursor/rules/team.mdc"))).rejects.toThrow(/Symlinks/);
      await mkdir(path.join(root, ".cursor", "skills"), { recursive: true });
      await symlink(outside, path.join(root, ".cursor", "skills", "leak.md"));
      await expect(writeFile(root, file(".cursor/skills/leak.md", "nope"))).rejects.toThrow(/Symlinks/);
      expect(await readFile(outside, "utf8")).toBe("sentinel");
    } finally { await cleanup(); }
  });

  it("rejects a workspace root symlink and leaves the outside sentinel alone", async () => {
    const { root, outside, cleanup } = await workspace();
    try {
      const linked = `${root}-linked`;
      await symlink(root, linked);
      await expect(writeFile(linked, file(".cursor/rules/team.mdc"))).rejects.toThrow(/symlink/i);
      expect(await readFile(outside, "utf8")).toBe("sentinel");
      await rm(linked, { force: true });
    } finally { await cleanup(); }
  });

  it("rejects sibling destinations", async () => {
    const { root, outside, cleanup } = await workspace();
    try {
      await expect(writeFile(root, file(".vscode/settings.json"))).rejects.toThrow(/Managed files/);
      expect(await readFile(outside, "utf8")).toBe("sentinel");
    } finally { await cleanup(); }
  });

  it("ignores leftover temp files and leaves the outside sentinel alone", async () => {
    const { root, outside, cleanup } = await workspace();
    try {
      await writeFile(root, file(".cursor/rules/team.mdc", "team"));
      await writeNode(path.join(root, ".cursor", "rules", ".rulesync-tmp-precreated"), "collision");
      await expect(listFiles(root)).resolves.toMatchObject([{ path: ".cursor/rules/team.mdc" }]);
      await writeFile(root, file(".cursor/rules/team.mdc", "next"));
      expect(await readFile(path.join(root, ".cursor", "rules", "team.mdc"), "utf8")).toBe("next");
      expect(await readFile(outside, "utf8")).toBe("sentinel");
    } finally { await cleanup(); }
  });
});
