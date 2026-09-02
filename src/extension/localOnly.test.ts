import { describe, expect, it } from "vitest";

import { excludeLocalOnly, isLocalOnlyPath, LocalOnlyRegistryError, parseLocalOnlyRegistry, serializeLocalOnlyRegistry } from "./localOnly.js";

describe("parseLocalOnlyRegistry", () => {
  it("treats missing state as empty", () => {
    expect(parseLocalOnlyRegistry(undefined)).toEqual([]);
  });

  it("dedupes, sorts, and canonicalizes disabled paths", () => {
    expect(parseLocalOnlyRegistry({ version: 1, paths: [".cursor/rules/b.mdc", ".cursor/rules/a.mdc.off", ".cursor/rules/b.mdc"] })).toEqual([".cursor/rules/a.mdc", ".cursor/rules/b.mdc"]);
  });

  it("fails closed on malformed values", () => {
    expect(() => parseLocalOnlyRegistry({ version: 2, paths: [] })).toThrow(LocalOnlyRegistryError);
    expect(() => parseLocalOnlyRegistry({ version: 1 })).toThrow(LocalOnlyRegistryError);
    expect(() => parseLocalOnlyRegistry({ version: 1, paths: ["src/secret.md"] })).toThrow(LocalOnlyRegistryError);
    expect(() => parseLocalOnlyRegistry([".cursor/rules/a.mdc"])).toThrow(LocalOnlyRegistryError);
    expect(() => parseLocalOnlyRegistry({ version: 1, paths: [1] })).toThrow(LocalOnlyRegistryError);
  });
});

describe("serializeLocalOnlyRegistry", () => {
  it("writes a sorted versioned document", () => {
    expect(serializeLocalOnlyRegistry([".cursor/rules/z.mdc", ".cursor/hooks.json"])).toEqual({ version: 1, paths: [".cursor/hooks.json", ".cursor/rules/z.mdc"] });
  });
});

describe("local-only path filter", () => {
  it("matches canonical paths and drops registered remotes", () => {
    const registry = new Set([".cursor/rules/private.mdc"]);
    expect(isLocalOnlyPath(".cursor/rules/private.mdc.off", registry)).toBe(true);
    expect(excludeLocalOnly([{ path: ".cursor/rules/private.mdc" }, { path: ".cursor/rules/team.mdc" }], registry)).toEqual([{ path: ".cursor/rules/team.mdc" }]);
  });
});
