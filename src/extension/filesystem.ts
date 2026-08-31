import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assertNoCaseCollisions, canonicalPath, type FileEntry } from "@rulesync/core";

export function workspacePath(root: string, relative: string): string {
  const safe = canonicalPath(relative);
  const target = path.resolve(root, safe);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("Path is outside the workspace.");
  return target;
}

export function hash(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function listFiles(root: string, relativeRoot = ".cursor"): Promise<FileEntry[]> {
  const base = workspacePath(root, relativeRoot);
  const entries: FileEntry[] = [];
  async function visit(directory: string): Promise<void> {
    let children;
    try { children = await fs.readdir(directory, { withFileTypes: true }); } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const child of children) {
      if (child.name === ".DS_Store") continue;
      const absolute = path.join(directory, child.name);
      const relative = canonicalPath(path.relative(root, absolute));
      if (child.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${relative}`);
      if (child.isDirectory()) await visit(absolute);
      else if (child.isFile()) {
        const contents = new Uint8Array(await fs.readFile(absolute));
        const stat = await fs.stat(absolute);
        entries.push({ path: relative, contentHash: hash(contents), size: contents.byteLength, mode: stat.mode & 0o111 ? "executable" : "file", content: contents });
      }
    }
  }
  await visit(base);
  assertNoCaseCollisions(entries.map((entry) => entry.path));
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export async function writeFile(root: string, entry: FileEntry): Promise<void> {
  const target = workspacePath(root, entry.path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.rulesync-tmp-${process.pid}`;
  await fs.writeFile(temporary, entry.content ?? new Uint8Array());
  if (entry.mode === "executable") await fs.chmod(temporary, 0o755);
  await fs.rename(temporary, target);
}

export async function removeFile(root: string, relative: string): Promise<void> {
  await fs.rm(workspacePath(root, relative), { force: true });
}

export async function renameFile(root: string, previous: string, next: string): Promise<void> {
  const destination = workspacePath(root, next);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(workspacePath(root, previous), destination);
}
