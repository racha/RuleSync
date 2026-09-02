import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assertManagedCursorPath, assertNoCaseCollisions, canonicalPath, type FileEntry } from "@rulesync/core";

export function workspacePath(root: string, relative: string): string {
  const safe = assertManagedCursorPath(relative);
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, safe);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Path is outside the workspace.");
  return target;
}

export function hash(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function lstatOrUndefined(target: string): Promise<import("node:fs").Stats | undefined> {
  try { return await fs.lstat(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertInside(root: string, target: string): void {
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Path is outside the workspace.");
}

// ponytail: Node has no openat; each lstat/realpath/rename is a window. Exclusive wx temps plus re-check before rename is the ceiling.
export async function assertSafeManagedPath(root: string, relative: string, options?: { createParents?: boolean }): Promise<string> {
  const safe = assertManagedCursorPath(relative);
  const resolvedRoot = path.resolve(root);
  const rootStat = await fs.lstat(resolvedRoot);
  if (rootStat.isSymbolicLink()) throw new Error("Workspace root cannot be a symlink.");
  const realRoot = await fs.realpath(resolvedRoot);
  let current = resolvedRoot;
  let realCurrent = realRoot;
  const parts = safe.split("/");
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    assertInside(resolvedRoot, current);
    const stat = await lstatOrUndefined(current);
    if (!stat) {
      if (index === parts.length - 1) return current;
      if (!options?.createParents) throw new Error(`Missing ${parts.slice(0, index + 1).join("/")}`);
      await fs.mkdir(current);
      const created = await fs.lstat(current);
      if (created.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${parts.slice(0, index + 1).join("/")}`);
      realCurrent = await fs.realpath(current);
      assertInside(realRoot, realCurrent);
      continue;
    }
    if (stat.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${parts.slice(0, index + 1).join("/")}`);
    realCurrent = await fs.realpath(current);
    assertInside(realRoot, realCurrent);
  }
  return current;
}

export async function listFiles(root: string, relativeRoot = ".cursor"): Promise<FileEntry[]> {
  const base = await assertSafeManagedPath(root, relativeRoot);
  const entries: FileEntry[] = [];
  async function visit(directory: string): Promise<void> {
    let children;
    try { children = await fs.readdir(directory, { withFileTypes: true }); } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const child of children) {
      if (child.name === ".DS_Store" || child.name.startsWith(".rulesync-tmp-")) continue;
      const absolute = path.join(directory, child.name);
      const relative = canonicalPath(path.relative(root, absolute));
      assertManagedCursorPath(relative);
      if (child.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${relative}`);
      if (child.isDirectory()) await visit(absolute);
      else if (child.isFile()) {
        const contents = new Uint8Array(await fs.readFile(absolute));
        const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${relative}`);
        entries.push({ path: relative, contentHash: hash(contents), size: contents.byteLength, mode: stat.mode & 0o111 ? "executable" : "file", content: contents });
      }
    }
  }
  await visit(base);
  assertNoCaseCollisions(entries.map((entry) => entry.path));
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export async function writeFile(root: string, entry: FileEntry): Promise<void> {
  const target = await assertSafeManagedPath(root, entry.path, { createParents: true });
  const parent = path.dirname(target);
  const temporary = path.join(parent, `.rulesync-tmp-${randomBytes(16).toString("hex")}`);
  const handle = await fs.open(temporary, "wx");
  try {
    await handle.writeFile(entry.content ?? new Uint8Array());
    if (entry.mode === "executable") await handle.chmod(0o755);
    await handle.close();
    await assertSafeManagedPath(root, entry.path, { createParents: true });
    const parentStat = await fs.lstat(parent);
    if (parentStat.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${path.relative(root, parent)}`);
    const targetStat = await lstatOrUndefined(target);
    if (targetStat?.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${entry.path}`);
    await fs.rename(temporary, target);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeFile(root: string, relative: string): Promise<void> {
  const target = await assertSafeManagedPath(root, relative);
  const stat = await lstatOrUndefined(target);
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${relative}`);
  await assertSafeManagedPath(root, relative);
  await fs.rm(target, { force: true });
}

export async function renameFile(root: string, previous: string, next: string): Promise<void> {
  const source = await assertSafeManagedPath(root, previous);
  const destination = await assertSafeManagedPath(root, next, { createParents: true });
  const sourceStat = await lstatOrUndefined(source);
  if (sourceStat?.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${previous}`);
  const destinationStat = await lstatOrUndefined(destination);
  if (destinationStat?.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${next}`);
  await fs.rename(source, destination);
}
