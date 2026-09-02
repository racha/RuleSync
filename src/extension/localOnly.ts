import { assertManagedCursorPath, canonicalManagedPath, UnsafePathError } from "@rulesync/core";

export const localOnlyRegistryVersion = 1;

export interface LocalOnlyRegistry {
  version: 1;
  paths: string[];
}

export class LocalOnlyRegistryError extends Error {
  override name = "LocalOnlyRegistryError";
}

export function normalizeLocalOnlyPath(input: string): string {
  try { return canonicalManagedPath(assertManagedCursorPath(input)); } catch (error) {
    if (error instanceof UnsafePathError) throw new LocalOnlyRegistryError("Local-only registry is invalid.");
    throw error;
  }
}

export function parseLocalOnlyRegistry(value: unknown): string[] {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalOnlyRegistryError("Local-only registry is invalid.");
  const { version, paths } = value as { version?: unknown; paths?: unknown };
  if (version !== localOnlyRegistryVersion || !Array.isArray(paths)) throw new LocalOnlyRegistryError("Local-only registry is invalid.");
  const next = new Set<string>();
  for (const itemPath of paths) {
    if (typeof itemPath !== "string") throw new LocalOnlyRegistryError("Local-only registry is invalid.");
    next.add(normalizeLocalOnlyPath(itemPath));
  }
  return [...next].sort((left, right) => left.localeCompare(right));
}

export function serializeLocalOnlyRegistry(paths: readonly string[]): LocalOnlyRegistry {
  return { version: 1, paths: parseLocalOnlyRegistry({ version: 1, paths: [...paths] }) };
}

export function isLocalOnlyPath(itemPath: string, registry: ReadonlySet<string>): boolean {
  return registry.has(canonicalManagedPath(itemPath));
}

export function excludeLocalOnly<T extends { path: string }>(entries: readonly T[], registry: ReadonlySet<string>): T[] {
  return entries.filter((entry) => !isLocalOnlyPath(entry.path, registry));
}
