import type { FileEntry, RulesProvider } from "@rulesync/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vscode = vi.hoisted(() => createVscodeFake());

vi.mock("vscode", () => vscode);

import { RuleSyncController } from "./controller.js";
import { hash } from "./filesystem.js";

const file = (relative: string, text = "ok"): FileEntry => ({ path: relative, contentHash: text, size: text.length, mode: "file", content: new TextEncoder().encode(text) });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

type FakeFolder = { name: string; index: number; uri: { scheme: string; fsPath: string; toString: () => string } };

function workspaceFolder(fsPath: string, name = fsPath.split("/").pop() ?? fsPath): FakeFolder {
  return { name, index: 0, uri: { scheme: "file", fsPath, toString: () => `file://${fsPath}` } };
}

function createVscodeFake() {
  const secrets = new Map<string, string>();
  const workspaceState = new Map<string, unknown>();
  const globalState = new Map<string, unknown>();
  const config: Record<string, unknown> = { sources: [], projectInitialized: false, optOut: [], githubAppClientId: "Iv23attacker-client-id" };
  const folderValues = new Map<string, Record<string, unknown>>();
  const folderListeners: Array<(event: { added: FakeFolder[]; removed: FakeFolder[] }) => void> = [];
  const focusListeners: Array<(state: { focused: boolean }) => void> = [];
  const defaultFolder = workspaceFolder("/tmp/rulesync-ws");
  let folders: FakeFolder[] = [defaultFolder];
  let trusted = true;
  const trustListeners: Array<() => void> = [];
  return {
    trusted: () => trusted,
    reset() {
      trusted = true;
      trustListeners.length = 0;
      folderListeners.length = 0;
      focusListeners.length = 0;
      folderValues.clear();
      folders = [workspaceFolder("/tmp/rulesync-ws")];
      this.window.showWarningMessage = async (_message: string, _options: unknown, confirm?: string) => confirm;
    },
    setTrusted(next: boolean) {
      const granted = next && !trusted;
      trusted = next;
      if (granted) trustListeners.forEach((listener) => listener());
    },
    fireFocus() { focusListeners.forEach((listener) => listener({ focused: true })); },
    setFolders(next: FakeFolder[]) {
      const previous = folders;
      folders = next.map((folder, index) => ({ ...folder, index }));
      const added = folders.filter((folder) => !previous.some((item) => item.uri.toString() === folder.uri.toString()));
      const removed = previous.filter((folder) => !folders.some((item) => item.uri.toString() === folder.uri.toString()));
      folderListeners.forEach((listener) => listener({ added, removed }));
    },
    secrets,
    workspaceState,
    globalState,
    config,
    folderValues,
    EventEmitter: class {
      listeners: Array<(value: unknown) => void> = [];
      event = (listener: (value: unknown) => void) => {
        this.listeners.push(listener);
        return { dispose: () => undefined };
      };
      fire(value: unknown) { this.listeners.forEach((listener) => listener(value)); }
      dispose() { this.listeners = []; }
    },
    Uri: {
      parse: (value: string) => ({ toString: () => value, scheme: value.split(":")[0], fsPath: value }),
      file: (value: string) => ({ toString: () => value, scheme: "file", fsPath: value })
    },
    ConfigurationTarget: { Workspace: 1, Global: 2, WorkspaceFolder: 3 },
    workspace: {
      get isTrusted() { return trusted; },
      get workspaceFolders() { return folders; },
      getConfiguration: (_section?: string, resource?: { toString: () => string }) => ({
        get: (key: string, fallback?: unknown) => {
          if (resource) {
            const scoped = folderValues.get(resource.toString());
            if (scoped && key in scoped) return scoped[key];
          }
          return config[key] ?? fallback;
        },
        update: async (key: string, value: unknown, target?: number) => {
          if (target === 3 && resource) {
            const next = { ...folderValues.get(resource.toString()) ?? {} };
            if (value === undefined) delete next[key];
            else next[key] = value;
            folderValues.set(resource.toString(), next);
            return;
          }
          if (value === undefined) delete config[key];
          else config[key] = value;
        },
        inspect: (key: string) => ({
          workspaceValue: config[key],
          workspaceFolderValue: resource ? folderValues.get(resource.toString())?.[key] : undefined,
          globalValue: undefined
        })
      }),
      onDidChangeConfiguration: () => ({ dispose: () => undefined }),
      onDidChangeWorkspaceFolders: (listener: (event: { added: FakeFolder[]; removed: FakeFolder[] }) => void) => {
        folderListeners.push(listener);
        return { dispose: () => undefined };
      },
      onDidGrantWorkspaceTrust: (listener: () => void) => {
        trustListeners.push(listener);
        return { dispose: () => undefined };
      },
      registerTextDocumentContentProvider: () => ({ dispose: () => undefined })
    },
    window: {
      onDidChangeWindowState: (listener: (state: { focused: boolean }) => void) => {
        focusListeners.push(listener);
        return { dispose: () => undefined };
      },
      showInformationMessage: async () => undefined,
      showWarningMessage: async (_message: string, _options: unknown, confirm?: string) => confirm,
      showInputBox: async () => undefined as string | undefined,
      showTextDocument: async (_uri?: { fsPath: string }) => undefined
    },
    env: {
      openExternal: async () => true,
      clipboard: { writeText: async () => undefined }
    },
    commands: { executeCommand: async () => undefined }
  };
}

function provider(overrides: Partial<RulesProvider> = {}): RulesProvider & { calls: string[] } {
  const calls: string[] = [];
  const github = {
    calls,
    verifyRepository: async () => { calls.push("verify"); return { defaultBranch: "main", fullName: "acme/rules" }; },
    authenticatedLogin: async () => { calls.push("login"); return "ada"; },
    listAccessibleRepositories: async () => { calls.push("list"); return [{ repository: "acme/rules", defaultBranch: "main", private: true }]; },
    getRef: async () => { calls.push("getRef"); return "abc"; },
    isEmptyRepository: async () => { calls.push("isEmpty"); return false; },
    getTree: async (_repo: string, _commit: string, prefix?: string) => { calls.push(`getTree:${prefix ?? ""}`); return []; },
    getBlob: async () => { calls.push("getBlob"); return new Uint8Array(); },
    getFileAtRef: async (_repo: string, _ref: string, path: string) => { calls.push(`getFileAtRef:${path}`); return new Uint8Array(); },
    createProposal: async () => { calls.push("createProposal"); return { branch: "rulesync/ada/1", headCommit: "def", compareUrl: "https://github.com/acme/rules/compare/main...x" }; },
    createReviewRequest: async () => { calls.push("createReview"); return { number: 1, url: "https://github.com/acme/rules/pull/1", state: "open" as const }; },
    findReviewRequest: async () => { calls.push("findReview"); return undefined; },
    compareUrl: () => "https://github.com/acme/rules/compare/main...x",
    repositoryUrl: () => "https://github.com/acme/rules",
    getFileAuthorship: async () => undefined,
    ...overrides
  };
  return github;
}

function context(): { context: ConstructorParameters<typeof RuleSyncController>[0]; writes: string[] } {
  const writes: string[] = [];
  const store = (map: Map<string, unknown>) => ({
    get: <T>(key: string) => map.get(key) as T | undefined,
    update: async (key: string, value: unknown) => { if (value === undefined) map.delete(key); else map.set(key, value); }
  });
  return {
    writes,
    context: {
      subscriptions: { push: () => undefined },
      secrets: {
        get: async (key: string) => vscode.secrets.get(key),
        store: async (key: string, value: string) => { vscode.secrets.set(key, value); },
        delete: async (key: string) => { vscode.secrets.delete(key); }
      },
      workspaceState: store(vscode.workspaceState),
      globalState: store(vscode.globalState)
    } as never
  };
}

function controller(remote = provider(), local: FileEntry[] = []) {
  const { context: extensionContext, writes } = context();
  const writesSeen = writes;
  const instance = new RuleSyncController(extensionContext, {
    createGithub: () => remote,
    createGitlab: () => remote,
    listFiles: async () => local,
    writeFile: async (_root, entry) => { writesSeen.push(entry.path); },
    removeFile: async (_root, relative) => { writesSeen.push(`rm:${relative}`); },
    renameFile: async () => undefined,
    watch: () => ({ on: () => undefined, close: () => undefined }) as never
  });
  return { instance, remote, writes: writesSeen };
}

function hashed(relative: string, text = "ok"): FileEntry {
  const content = new TextEncoder().encode(text);
  return { path: relative, contentHash: hash(content), size: content.byteLength, mode: "file", content };
}

function mutableController(remote = provider(), initial: FileEntry[] = []) {
  const files = initial.map((entry) => ({ ...entry, content: entry.content ? new Uint8Array(entry.content) : new Uint8Array() }));
  const writes: string[] = [];
  const renames: string[] = [];
  const { context: extensionContext } = context();
  const instance = new RuleSyncController(extensionContext, {
    createGithub: () => remote,
    createGitlab: () => remote,
    listFiles: async () => files.map((entry) => ({ ...entry, content: entry.content ? new Uint8Array(entry.content) : new Uint8Array() })),
    writeFile: async (_root, entry) => {
      writes.push(entry.path);
      const next = { ...entry, content: entry.content ? new Uint8Array(entry.content) : new Uint8Array() };
      const index = files.findIndex((item) => item.path === entry.path);
      if (index === -1) files.push(next);
      else files[index] = next;
    },
    removeFile: async (_root, relative) => {
      writes.push(`rm:${relative}`);
      const index = files.findIndex((item) => item.path === relative);
      if (index !== -1) files.splice(index, 1);
    },
    renameFile: async (_root, previous, next) => {
      renames.push(`${previous}->${next}`);
      const index = files.findIndex((item) => item.path === previous);
      if (index === -1) throw new Error(`missing ${previous}`);
      files[index] = { ...files[index]!, path: next };
    },
    watch: () => ({ on: () => undefined, close: () => undefined }) as never
  });
  return { instance, remote, files, writes, renames };
}

function connectedRemote(entry: FileEntry, overrides: Partial<RulesProvider> = {}) {
  return provider({
    getTree: async () => [{ path: entry.path, oid: "blob", mode: entry.mode, size: entry.size }],
    getBlob: async () => entry.content ?? new Uint8Array(),
    ...overrides
  });
}

function connectedRemotes(entries: FileEntry[], overrides: Partial<RulesProvider> = {}) {
  const blobs = new Map(entries.map((entry) => [entry.contentHash, entry.content ?? new Uint8Array()]));
  return provider({
    getTree: async () => entries.map((entry) => ({ path: entry.path, oid: entry.contentHash, mode: entry.mode, size: entry.size })),
    getBlob: async (_repo, oid) => blobs.get(oid) ?? new Uint8Array(),
    ...overrides
  });
}

describe("RuleSyncController", () => {
  beforeEach(() => {
    vscode.secrets.clear();
    vscode.workspaceState.clear();
    vscode.globalState.clear();
    vscode.config.sources = [];
    vscode.config.projectInitialized = false;
    vscode.config["updateCheck.mode"] = "off";
    vscode.reset();
  });

  afterEach(() => { vi.useRealTimers(); });

  it("does not enumerate files, watch, or use secrets while the workspace is untrusted", async () => {
    vscode.setTrusted(false);
    let listed = 0;
    let watched = 0;
    const remote = provider();
    const { context: extensionContext } = context();
    const instance = new RuleSyncController(extensionContext, {
      createGithub: () => remote,
      listFiles: async () => { listed += 1; return []; },
      watch: () => { watched += 1; return { on: () => undefined, close: () => undefined } as never; }
    });
    await instance.initialize();
    const state = instance.dashboardState();
    expect(listed).toBe(0);
    expect(watched).toBe(0);
    expect(remote.calls).toEqual([]);
    expect(vscode.secrets.size).toBe(0);
    expect(state.trusted).toBe(false);
    expect(state.items).toEqual([]);
    expect(state.githubConnected).toBe(false);
    await expect(instance.handle({ type: "auth.start" })).rejects.toThrow(/Trust this workspace/);
    await instance.handle({ type: "source.disconnect" });
  });

  it("forgets a GitHub session from setup", async () => {
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    vscode.secrets.set("rulesync.github.refreshToken", "refresh");
    const { instance } = controller();
    await instance.initialize();
    expect(instance.dashboardState().githubConnected).toBe(true);
    await instance.handle({ type: "auth.forget" });
    expect(instance.dashboardState().githubConnected).toBe(false);
    expect(vscode.secrets.get("rulesync.github.accessToken")).toBeUndefined();
    expect(vscode.secrets.get("rulesync.github.refreshToken")).toBeUndefined();
  });

  it("initializes after trust is granted", async () => {
    vscode.setTrusted(false);
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    const remote = provider();
    const { instance } = controller(remote);
    await instance.initialize();
    expect(remote.calls).toEqual([]);
    vscode.setTrusted(true);
    await instance.initialize();
    expect(instance.dashboardState().githubConnected).toBe(true);
  });

  it("requests only .cursor and never fetches rulesync.yml", async () => {
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    vscode.config.projectInitialized = true;
    vscode.config.sources = [{ id: "team", provider: "github", repository: "acme/rules", profile: "cursor-project", enabled: true }];
    const remote = provider({
      getTree: async (_repo, _commit, prefix) => {
        remote.calls.push(`getTree:${prefix ?? ""}`);
        return [
          { path: ".cursor/rules/a.mdc", oid: "a", mode: "file", size: 2 },
          { path: ".vscode/settings.json", oid: "v", mode: "file", size: 2 },
          { path: "src/app.ts", oid: "s", mode: "file", size: 2 }
        ];
      },
      getBlob: async (_repo, oid) => {
        remote.calls.push(`getBlob:${oid}`);
        return new TextEncoder().encode(oid === "a" ? "ok" : "nope");
      }
    });
    const { instance } = controller(remote);
    await instance.initialize();
    await instance.refresh();
    expect(remote.calls.filter((call) => call.startsWith("getFileAtRef"))).toEqual([]);
    expect(remote.calls).toContain("getTree:.cursor");
    expect(instance.dashboardState().items.map((item) => item.path)).toEqual([".cursor/rules/a.mdc"]);
    expect(instance.dashboardState().manifestStatus).toBe("ready");
  });

  it("treats a missing .cursor subtree as a valid empty remote", async () => {
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    vscode.config.sources = [{ id: "team", provider: "github", repository: "acme/rules", profile: "cursor-project", enabled: true }];
    const { instance } = controller(provider());
    await instance.initialize();
    await instance.refresh();
    expect(instance.dashboardState().manifestStatus).toBe("ready");
    expect(instance.dashboardState().items).toEqual([]);
  });

  it("uses the bundled GitHub client ID even when workspace settings override it", async () => {
    const requested: string[] = [];
    const { context: extensionContext } = context();
    const instance = new RuleSyncController(extensionContext, {
      requestDeviceCode: async (clientId) => {
        requested.push(clientId);
        throw new Error("stop");
      },
      listFiles: async () => [],
      watch: () => ({ on: () => undefined, close: () => undefined }) as never
    });
    await instance.initialize();
    await instance.handle({ type: "auth.start" });
    expect(requested).toEqual(["Iv23li1SFwqQ6d45EmWN"]);
    expect(vscode.config.githubAppClientId).toBe("Iv23attacker-client-id");
  });

  it("rejects an unapproved custom GitLab host for PAT save and source save", async () => {
    const { instance } = controller();
    await instance.initialize();
    await expect(instance.handle({ type: "gitlab.pat.save", baseUrl: "https://gitlab.example.com", token: "glpat-secret" })).rejects.toThrow(/Approve/);
    vscode.window.showWarningMessage = async () => "Allow this host";
    await instance.handle({ type: "gitlab.host.approve", baseUrl: "https://gitlab.example.com" });
    expect(instance.dashboardState().gitlabApprovedHosts).toContain("https://gitlab.example.com");
    expect(instance.dashboardState().statusMessage).not.toMatch(/Approve /);
    expect(instance.dashboardState().statusMessage).toMatch(/Paste a GitLab personal access token/);
    await expect(instance.handle({ type: "source.save", source: { id: "team", provider: "gitlab", repository: "group/project", profile: "cursor-project", baseUrl: "https://gitlab.example.com" } })).rejects.toThrow(/Connect GitLab/);
  });

  it("clears a leftover host-approval banner after the saved source host is approved", async () => {
    vscode.config.projectInitialized = true;
    vscode.config.sources = [{ id: "team", provider: "gitlab", repository: "inveon/cursor-rules", profile: "cursor-project", baseUrl: "https://gitlab.inveon.dev", enabled: true }];
    vscode.secrets.set("rulesync.gitlab.pat.https%3A%2F%2Fgitlab.inveon.dev", "glpat-existing-token-value");
    const remote = provider();
    const { instance } = controller(remote);
    await instance.initialize();
    expect(instance.dashboardState().statusMessage).toMatch(/Approve https:\/\/gitlab.inveon.dev/);
    vscode.window.showWarningMessage = async () => "Allow this host";
    await instance.handle({ type: "gitlab.host.approve", baseUrl: "https://gitlab.inveon.dev" });
    expect(instance.dashboardState().statusMessage).not.toMatch(/Approve /);
    expect(instance.dashboardState().gitlabConnected).toBe(true);
  });

  it("does not mutate an empty repository on refresh, legacy initialize, or publish", async () => {
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    vscode.config.sources = [{ id: "team", provider: "github", repository: "acme/rules", ref: "main", profile: "cursor-project", enabled: true }];
    const remote = provider({
      getRef: async () => { remote.calls.push("getRef"); throw Object.assign(new Error("Not Found"), { status: 404 }); },
      isEmptyRepository: async () => { remote.calls.push("isEmpty"); return true; }
    });
    const { instance } = controller(remote, [file(".cursor/rules/a.mdc")]);
    await instance.initialize();
    await instance.refresh();
    await instance.handle({ type: "manifest.initialize" });
    await expect(instance.handle({ type: "proposal.publish", message: "x" })).rejects.toThrow(/Create the default branch/);
    expect(remote.calls.includes("createProposal")).toBe(false);
    expect(instance.dashboardState().manifestStatus).toBe("empty");
  });

  it("skips authorship lookups once the remote set exceeds 50 files", async () => {
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    vscode.config.sources = [{ id: "team", provider: "github", repository: "acme/rules", profile: "cursor-project", enabled: true }];
    const remote = provider({
      getTree: async () => Array.from({ length: 51 }, (_, index) => ({ path: `.cursor/rules/f${index}.mdc`, oid: "a", mode: "file" as const, size: 1 })),
      getBlob: async () => new TextEncoder().encode("x"),
      getFileAuthorship: async () => { remote.calls.push("authorship"); return undefined; }
    });
    const { instance } = controller(remote);
    await instance.initialize();
    await instance.refresh();
    expect(instance.dashboardState().items).toHaveLength(51);
    expect(remote.calls.includes("authorship")).toBe(false);
  });

  it("blocks apply and publish until each high-risk file is accepted", async () => {
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    vscode.config.sources = [{ id: "team", provider: "github", repository: "acme/rules", profile: "cursor-project", enabled: true }];
    const hook = file(".cursor/hooks.json", "hooks");
    const remote = provider({
      getTree: async () => [{ path: hook.path, oid: "h", mode: "file", size: hook.size }],
      getBlob: async () => hook.content ?? new Uint8Array()
    });
    const { instance } = controller(remote);
    await instance.initialize();
    await instance.refresh();
    await expect(instance.handle({ type: "remote.apply", path: hook.path })).rejects.toThrow(/high-risk/);
    await instance.handle({ type: "risks.accept" });
    await expect(instance.handle({ type: "remote.apply", path: hook.path })).rejects.toThrow(/high-risk/);
    await instance.handle({ type: "risk.accept", path: hook.path, code: "hook" });
    expect(instance.dashboardState().risks.some((risk) => risk.code === "hook")).toBe(false);
    await instance.handle({ type: "remote.apply", path: hook.path });
  });

  it("discards a stale refresh after the source changes", async () => {
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    vscode.config.sources = [{ id: "team", provider: "github", repository: "acme/rules", profile: "cursor-project", enabled: true }];
    const tree = deferred<[]>();
    const first = provider({ getTree: async () => { first.calls.push("getTree:.cursor"); return tree.promise; } });
    const second = provider({
      verifyRepository: async () => ({ defaultBranch: "main", fullName: "acme/other" }),
      getTree: async () => [],
      getRef: async () => "zzz"
    });
    let current = first;
    const { context: extensionContext } = context();
    const instance = new RuleSyncController(extensionContext, {
      createGithub: () => current,
      listFiles: async () => [],
      watch: () => ({ on: () => undefined, close: () => undefined }) as never
    });
    await instance.initialize();
    const pending = instance.refresh();
    current = second;
    vscode.folderValues.set("file:///tmp/rulesync-ws", { sources: [{ id: "team", provider: "github", repository: "acme/other", profile: "cursor-project", enabled: true }] });
    await instance.initialize();
    tree.resolve([]);
    await pending;
    expect(instance.dashboardState().source?.repository).toBe("acme/other");
    expect(instance.dashboardState().status === "error").toBe(false);
  });

  it("keeps credentials out of dashboard state and forgets a host token without listing repos", async () => {
    vscode.secrets.set("rulesync.github.accessToken", "gho-super-secret");
    vscode.secrets.set("rulesync.gitlab.pat.https%3A%2F%2Fgitlab.com", "glpat-super-secret-token-value");
    const { instance } = controller();
    await instance.initialize();
    const snapshot = JSON.stringify(instance.dashboardState());
    expect(snapshot).not.toContain("gho-super-secret");
    expect(snapshot).not.toContain("glpat-");
    await instance.handle({ type: "gitlab.pat.forget", baseUrl: "https://gitlab.com" });
    expect(vscode.secrets.has("rulesync.gitlab.pat.https%3A%2F%2Fgitlab.com")).toBe(false);
    expect(vscode.secrets.get("rulesync.github.accessToken")).toBe("gho-super-secret");
    vscode.config.sources = [{ id: "team", provider: "github", repository: "acme/rules", profile: "cursor-project", enabled: true }];
    await instance.initialize();
    await instance.handle({ type: "source.disconnect" });
    expect(instance.dashboardState().source).toBeUndefined();
    expect(vscode.secrets.get("rulesync.github.accessToken")).toBe("gho-super-secret");
  });

  it("lets a GitHub repo list replace an in-flight GitLab list", async () => {
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    vscode.secrets.set("rulesync.gitlab.pat.https%3A%2F%2Fgitlab.com", "glpat-test");
    const gitlabList = deferred<Array<{ repository: string; defaultBranch: string; private: boolean }>>();
    const githubList = deferred<Array<{ repository: string; defaultBranch: string; private: boolean }>>();
    const gitlab = provider({ listAccessibleRepositories: async () => gitlabList.promise });
    const github = provider({ listAccessibleRepositories: async () => githubList.promise });
    const { context: extensionContext } = context();
    const instance = new RuleSyncController(extensionContext, {
      createGithub: () => github,
      createGitlab: () => gitlab,
      listFiles: async () => [],
      watch: () => ({ on: () => undefined, close: () => undefined }) as never
    });
    await instance.initialize();
    expect(instance.dashboardState().availableRepositories).toEqual([]);
    expect(instance.dashboardState().repositoriesStatus).toBe("idle");
    const gitlabRefresh = instance.handle({ type: "gitlab.repos.refresh" });
    await vi.waitFor(() => { expect(instance.dashboardState().repositoriesProvider).toBe("gitlab"); });
    const githubRefresh = instance.handle({ type: "github.repos.refresh" });
    await vi.waitFor(() => { expect(instance.dashboardState().repositoriesProvider).toBe("github"); });
    gitlabList.resolve([{ repository: "group/project", defaultBranch: "main", private: true }]);
    await gitlabRefresh;
    expect(instance.dashboardState().availableRepositories).toEqual([]);
    expect(instance.dashboardState().repositoriesStatus).toBe("loading");
    githubList.resolve([{ repository: "racha/cursor-rules", defaultBranch: "main", private: true }]);
    await githubRefresh;
    expect(instance.dashboardState().repositoriesProvider).toBe("github");
    expect(instance.dashboardState().repositoriesStatus).toBe("ready");
    expect(instance.dashboardState().availableRepositories).toEqual([{ repository: "racha/cursor-rules", defaultBranch: "main", private: true }]);
  });

  it("restores a locally deleted file from remote on revert", async () => {
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    vscode.config.projectInitialized = true;
    vscode.config.sources = [{ id: "team", provider: "github", repository: "acme/rules", profile: "cursor-project", enabled: true }];
    const remote = hashed(".cursor/rules/foo.mdc", "remote");
    vscode.workspaceState.set("rulesync.syncState.v1", { schemaVersion: 1, sourceIdentity: "github:acme/rules:default:cursor-project", entries: { [remote.path]: { localHash: remote.contentHash, remoteOid: remote.contentHash, mode: "file" } } });
    const { instance, writes, files } = mutableController(connectedRemote(remote), []);
    await instance.initialize();
    await instance.refresh();
    const deleted = instance.dashboardState().items.find((item) => item.path === remote.path);
    expect(deleted?.status).toBe("local");
    expect(deleted?.kind).toBe("deleted");
    await instance.handle({ type: "content.revert", path: remote.path });
    expect(writes).toContain(remote.path);
    expect(files.some((entry) => entry.path === remote.path)).toBe(true);
    expect(instance.dashboardState().items.find((item) => item.path === remote.path)?.status).toBe("synced");
  });

  it("restores remote files and removes local-only files", async () => {
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    vscode.config.projectInitialized = true;
    vscode.config.sources = [{ id: "team", provider: "github", repository: "acme/rules", profile: "cursor-project", enabled: true }];
    const keep = hashed(".cursor/rules/keep.mdc", "keep");
    const extra = hashed(".cursor/rules/extra.mdc", "extra");
    vscode.workspaceState.set("rulesync.syncState.v1", { schemaVersion: 1, sourceIdentity: "github:acme/rules:default:cursor-project", entries: { [keep.path]: { localHash: keep.contentHash, remoteOid: keep.contentHash, mode: "file" } } });
    const { instance, writes, files } = mutableController(connectedRemotes([keep]), [extra]);
    await instance.initialize();
    await instance.refresh();
    await instance.handle({ type: "remote.restore" });
    expect(writes).toContain(keep.path);
    expect(writes).toContain("rm:.cursor/rules/extra.mdc");
    expect(files.map((entry) => entry.path)).toEqual([keep.path]);
    expect(instance.dashboardState().localCount).toBe(0);
    expect(instance.dashboardState().status).toBe("synced");
  });

  it("blocks restore from remote until each high-risk file is accepted", async () => {
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    vscode.config.projectInitialized = true;
    vscode.config.sources = [{ id: "team", provider: "github", repository: "acme/rules", profile: "cursor-project", enabled: true }];
    const hook = hashed(".cursor/hooks.json", "hooks");
    const { instance, writes } = mutableController(connectedRemote(hook), []);
    await instance.initialize();
    await instance.refresh();
    await expect(instance.handle({ type: "remote.restore" })).rejects.toThrow(/high-risk/);
    await instance.handle({ type: "risk.accept", path: hook.path, code: "hook" });
    await instance.handle({ type: "remote.restore" });
    expect(writes).toContain(hook.path);
    expect(instance.dashboardState().items.find((item) => item.path === hook.path)?.status).toBe("synced");
  });

  it("disables and enables a local file without creating a sync change", async () => {
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    vscode.config.projectInitialized = true;
    vscode.config.sources = [{ id: "team", provider: "github", repository: "acme/rules", profile: "cursor-project", enabled: true }];
    const local = hashed(".cursor/rules/foo.mdc", "same");
    const { instance, renames } = mutableController(connectedRemote(local), [local]);
    await instance.initialize();
    await instance.refresh();
    await instance.handle({ type: "content.disable", path: local.path });
    expect(renames).toEqual([".cursor/rules/foo.mdc->.cursor/rules/foo.mdc.off"]);
    const disabled = instance.dashboardState().items.find((item) => item.path === local.path);
    expect(disabled?.disabled).toBe(true);
    expect(disabled?.name).toBe("foo.mdc");
    expect(disabled?.status).toBe("synced");
    expect(instance.dashboardState().localCount).toBe(0);
    await instance.handle({ type: "content.enable", path: local.path });
    expect(renames.at(-1)).toBe(".cursor/rules/foo.mdc.off->.cursor/rules/foo.mdc");
    expect(instance.dashboardState().items.find((item) => item.path === local.path)?.disabled).toBe(false);
  });

  it("rejects disable when untrusted, for hook scripts, and when the remote already has .off", async () => {
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    vscode.config.projectInitialized = true;
    vscode.config.sources = [{ id: "team", provider: "github", repository: "acme/rules", profile: "cursor-project", enabled: true }];
    const rule = hashed(".cursor/rules/foo.mdc");
    const hook = hashed(".cursor/hooks/record.sh");
    const collision = provider({
      getTree: async () => [
        { path: rule.path, oid: "rule", mode: "file", size: rule.size },
        { path: `${rule.path}.off`, oid: "off", mode: "file", size: 3 }
      ],
      getBlob: async (_repo, oid) => oid === "off" ? new TextEncoder().encode("off") : rule.content ?? new Uint8Array()
    });
    const { instance } = mutableController(collision, [rule]);
    await instance.initialize();
    await instance.refresh();
    await expect(instance.handle({ type: "content.disable", path: rule.path })).rejects.toThrow(/disabled path/);
    const { instance: hooks } = mutableController(connectedRemote(hook), [hook]);
    await hooks.initialize();
    await expect(hooks.handle({ type: "content.disable", path: hook.path })).rejects.toThrow(/Hook scripts/);
    vscode.setTrusted(false);
    await expect(instance.handle({ type: "content.disable", path: rule.path })).rejects.toThrow(/Trust this workspace/);
    await expect(instance.handle({ type: "content.enable", path: rule.path })).rejects.toThrow(/Trust this workspace/);
  });

  it("writes incoming updates and deletes through the .off disk path", async () => {
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    vscode.config.projectInitialized = true;
    vscode.config.sources = [{ id: "team", provider: "github", repository: "acme/rules", profile: "cursor-project", enabled: true }];
    const local = hashed(".cursor/rules/foo.mdc.off", "old");
    const remote = hashed(".cursor/rules/foo.mdc", "new");
    vscode.workspaceState.set("rulesync.syncState.v1", { schemaVersion: 1, sourceIdentity: "github:acme/rules:default:cursor-project", entries: { [remote.path]: { localHash: local.contentHash, remoteOid: local.contentHash, mode: "file" } } });
    const { instance, writes } = mutableController(connectedRemote(remote), [local]);
    await instance.initialize();
    await instance.refresh();
    expect(instance.dashboardState().items.find((item) => item.path === remote.path)?.disabled).toBe(true);
    await instance.handle({ type: "remote.apply", path: remote.path });
    expect(writes).toContain(".cursor/rules/foo.mdc.off");
    expect(instance.dashboardState().items.find((item) => item.path === remote.path)?.disabled).toBe(true);
  });

  it("removes the .off file when a disabled path is deleted remotely", async () => {
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    vscode.config.projectInitialized = true;
    vscode.config.sources = [{ id: "team", provider: "github", repository: "acme/rules", profile: "cursor-project", enabled: true }];
    const local = hashed(".cursor/rules/foo.mdc.off", "same");
    vscode.workspaceState.set("rulesync.syncState.v1", { schemaVersion: 1, sourceIdentity: "github:acme/rules:default:cursor-project", entries: { ".cursor/rules/foo.mdc": { localHash: local.contentHash, remoteOid: local.contentHash, mode: "file" } } });
    const { instance, writes } = mutableController(provider({ getTree: async () => [] }), [local]);
    await instance.initialize();
    await instance.refresh();
    await instance.handle({ type: "remote.apply", path: ".cursor/rules/foo.mdc" });
    expect(writes).toContain("rm:.cursor/rules/foo.mdc.off");
    expect(writes).toContain("rm:.cursor/rules/foo.mdc");
  });

  it("opens, renames, and deletes the .off disk form and publishes the canonical path", async () => {
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    vscode.config.projectInitialized = true;
    vscode.config.sources = [{ id: "team", provider: "github", repository: "acme/rules", profile: "cursor-project", enabled: true }];
    const remote = hashed(".cursor/rules/foo.mdc", "remote");
    const local = hashed(".cursor/rules/foo.mdc.off", "local");
    vscode.workspaceState.set("rulesync.syncState.v1", { schemaVersion: 1, sourceIdentity: "github:acme/rules:default:cursor-project", entries: { [remote.path]: { localHash: remote.contentHash, remoteOid: remote.contentHash, mode: "file" } } });
    const published: Array<{ path: string }> = [];
    const host = connectedRemote(remote, {
      createProposal: async (input) => {
        published.push(...input.changes);
        return { branch: "rulesync/ada/1", headCommit: "def", compareUrl: "https://github.com/acme/rules/compare/main...x" };
      }
    });
    const { instance, writes, renames } = mutableController(host, [local]);
    const opened: string[] = [];
    vscode.window.showTextDocument = async (uri?: { fsPath: string }) => { if (uri) opened.push(uri.fsPath); };
    vscode.window.showInputBox = async () => "bar.mdc";
    await instance.initialize();
    await instance.refresh();
    await instance.handle({ type: "content.open", path: remote.path });
    expect(opened.some((value) => value.endsWith(".cursor/rules/foo.mdc.off"))).toBe(true);
    await instance.handle({ type: "proposal.publish", message: "update foo" });
    expect(published.map((change) => change.path)).toEqual([".cursor/rules/foo.mdc"]);
    await instance.handle({ type: "content.rename", path: remote.path });
    expect(renames).toContain(".cursor/rules/foo.mdc.off->.cursor/rules/bar.mdc.off");
    await instance.handle({ type: "content.delete", path: ".cursor/rules/bar.mdc" });
    expect(writes).toContain("rm:.cursor/rules/bar.mdc.off");
  });

  it("keeps independent sources, watchers, remotes, and namespaced state for two folders", async () => {
    const alpha = workspaceFolder("/tmp/alpha", "alpha");
    const beta = workspaceFolder("/tmp/beta", "beta");
    vscode.setFolders([alpha, beta]);
    vscode.folderValues.set(alpha.uri.toString(), { projectInitialized: true, sources: [{ id: "team", provider: "github", repository: "acme/alpha", profile: "cursor-project", enabled: true }] });
    vscode.folderValues.set(beta.uri.toString(), { projectInitialized: true, sources: [{ id: "team", provider: "github", repository: "acme/beta", profile: "cursor-project", enabled: true }] });
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    const localA = hashed(".cursor/rules/a.mdc", "alpha");
    const localB = hashed(".cursor/rules/b.mdc", "beta");
    const files = new Map<string, FileEntry[]>([[alpha.uri.fsPath, [localA]], [beta.uri.fsPath, [localB]]]);
    const watches: string[] = [];
    const github = provider({
      verifyRepository: async (repo) => ({ defaultBranch: "main", fullName: repo }),
      getRef: async (repo) => repo === "acme/alpha" ? "aaa" : "bbb",
      getTree: async (repo) => repo === "acme/alpha"
        ? [{ path: localA.path, oid: "a", mode: "file", size: localA.size }]
        : [{ path: localB.path, oid: "b", mode: "file", size: localB.size }],
      getBlob: async (_repo, oid) => oid === "a" ? localA.content ?? new Uint8Array() : localB.content ?? new Uint8Array()
    });
    const { context: extensionContext } = context();
    const instance = new RuleSyncController(extensionContext, {
      createGithub: () => github,
      listFiles: async (root) => files.get(root) ?? [],
      watch: (target) => { watches.push(target); return { on: () => undefined, close: () => undefined } as never; }
    });
    await instance.initialize();
    expect(instance.dashboardState().folders).toHaveLength(2);
    expect(instance.dashboardState().workspaceName).toBe("alpha");
    expect(instance.dashboardState().source?.repository).toBe("acme/alpha");
    await instance.refresh();
    expect(instance.dashboardState().items.map((item) => item.path)).toEqual([localA.path]);
    await instance.handle({ type: "folder.select", folderUri: beta.uri.toString() });
    expect(instance.dashboardState().workspaceName).toBe("beta");
    expect(instance.dashboardState().source?.repository).toBe("acme/beta");
    await instance.refresh();
    expect(instance.dashboardState().items.map((item) => item.path)).toEqual([localB.path]);
    expect(watches.some((target) => target.includes("/tmp/alpha"))).toBe(true);
    expect(watches.some((target) => target.includes("/tmp/beta"))).toBe(true);
    expect(vscode.workspaceState.has(`rulesync.syncState.v1:${encodeURIComponent(alpha.uri.toString())}`)).toBe(true);
    expect(vscode.workspaceState.has(`rulesync.syncState.v1:${encodeURIComponent(beta.uri.toString())}`)).toBe(true);
  });

  it("checks every configured folder on start and only the selected folder on manual refresh", async () => {
    const alpha = workspaceFolder("/tmp/alpha", "alpha");
    const beta = workspaceFolder("/tmp/beta", "beta");
    vscode.setFolders([alpha, beta]);
    vscode.config["updateCheck.mode"] = "both";
    vscode.config["updateCheck.onStart"] = true;
    vscode.folderValues.set(alpha.uri.toString(), { projectInitialized: true, sources: [{ id: "team", provider: "github", repository: "acme/alpha", profile: "cursor-project", enabled: true }] });
    vscode.folderValues.set(beta.uri.toString(), { projectInitialized: true, sources: [{ id: "team", provider: "github", repository: "acme/beta", profile: "cursor-project", enabled: true }] });
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    const verified: string[] = [];
    const github = provider({
      verifyRepository: async (repo) => { verified.push(repo); return { defaultBranch: "main", fullName: repo }; },
      getRef: async (repo) => repo
    });
    const { context: extensionContext } = context();
    const instance = new RuleSyncController(extensionContext, {
      createGithub: () => github,
      listFiles: async () => [],
      watch: () => ({ on: () => undefined, close: () => undefined }) as never
    });
    await instance.initialize();
    expect(verified.sort()).toEqual(["acme/alpha", "acme/beta"]);
    verified.length = 0;
    await instance.handle({ type: "sync.refresh" });
    expect(verified).toEqual(["acme/alpha"]);
    await instance.handle({ type: "folder.select", folderUri: beta.uri.toString() });
    verified.length = 0;
    await instance.refresh();
    expect(verified).toEqual(["acme/beta"]);
  });

  it("does not cancel another folder’s in-flight refresh when selection changes", async () => {
    const alpha = workspaceFolder("/tmp/alpha", "alpha");
    const beta = workspaceFolder("/tmp/beta", "beta");
    vscode.setFolders([alpha, beta]);
    vscode.folderValues.set(alpha.uri.toString(), { projectInitialized: true, sources: [{ id: "team", provider: "github", repository: "acme/alpha", profile: "cursor-project", enabled: true }] });
    vscode.folderValues.set(beta.uri.toString(), { projectInitialized: true, sources: [{ id: "team", provider: "github", repository: "acme/beta", profile: "cursor-project", enabled: true }] });
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    const tree = deferred<[]>();
    const github = provider({
      verifyRepository: async (repo) => ({ defaultBranch: "main", fullName: repo }),
      getRef: async (repo) => repo,
      getTree: async (repo) => repo === "acme/alpha" ? tree.promise : []
    });
    const { context: extensionContext } = context();
    const instance = new RuleSyncController(extensionContext, {
      createGithub: () => github,
      listFiles: async () => [],
      watch: () => ({ on: () => undefined, close: () => undefined }) as never
    });
    await instance.initialize();
    const pending = instance.refresh();
    await instance.handle({ type: "folder.select", folderUri: beta.uri.toString() });
    await instance.refresh();
    expect(instance.dashboardState().source?.repository).toBe("acme/beta");
    expect(instance.dashboardState().status === "error").toBe(false);
    tree.resolve([]);
    await pending;
    expect(instance.dashboardState().source?.repository).toBe("acme/beta");
    expect(instance.dashboardState().folders.find((folder) => folder.uri === alpha.uri.toString())?.status).not.toBe("error");
  });

  it("does not steal selection when a folder is added and falls back when the selected folder is removed", async () => {
    const alpha = workspaceFolder("/tmp/alpha", "alpha");
    const beta = workspaceFolder("/tmp/beta", "beta");
    vscode.setFolders([alpha]);
    const { instance } = controller();
    await instance.initialize();
    expect(instance.dashboardState().selectedFolderUri).toBe(alpha.uri.toString());
    vscode.setFolders([alpha, beta]);
    await vi.waitFor(() => { expect(instance.dashboardState().folders.map((folder) => folder.name)).toEqual(["alpha", "beta"]); });
    expect(instance.dashboardState().selectedFolderUri).toBe(alpha.uri.toString());
    vscode.setFolders([beta]);
    await vi.waitFor(() => { expect(instance.dashboardState().selectedFolderUri).toBe(beta.uri.toString()); });
    expect(instance.dashboardState().workspaceName).toBe("beta");
  });

  it("shows an empty dashboard when no local folder is open", async () => {
    vscode.setFolders([]);
    const { instance } = controller();
    await instance.initialize();
    expect(instance.dashboardState().statusMessage).toBe("Open a local folder to use RuleSync.");
    expect(instance.dashboardState().folders).toEqual([]);
  });

  it("does not enumerate, watch, or use tokens in an untrusted multi-root window", async () => {
    vscode.setTrusted(false);
    vscode.setFolders([workspaceFolder("/tmp/alpha", "alpha"), workspaceFolder("/tmp/beta", "beta")]);
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    let listed = 0;
    let watched = 0;
    const remote = provider();
    const { context: extensionContext } = context();
    const instance = new RuleSyncController(extensionContext, {
      createGithub: () => remote,
      listFiles: async () => { listed += 1; return []; },
      watch: () => { watched += 1; return { on: () => undefined, close: () => undefined } as never; }
    });
    await instance.initialize();
    expect(listed).toBe(0);
    expect(watched).toBe(0);
    expect(remote.calls).toEqual([]);
    expect(instance.dashboardState().folders).toHaveLength(2);
    expect(instance.dashboardState().githubConnected).toBe(false);
    await instance.handle({ type: "folder.select", folderUri: "file:///tmp/beta" });
    expect(instance.dashboardState().selectedFolderUri).toBe("file:///tmp/beta");
    await expect(instance.handle({ type: "workspace.source.assign", folderUri: "file:///tmp/beta" })).rejects.toThrow(/Trust this workspace/);
  });

  it("keeps leftover workspace setup unassigned until one folder is chosen", async () => {
    const alpha = workspaceFolder("/tmp/alpha", "alpha");
    const beta = workspaceFolder("/tmp/beta", "beta");
    vscode.setFolders([alpha, beta]);
    vscode.config.sources = [{ id: "team", provider: "github", repository: "acme/legacy", profile: "cursor-project", enabled: true }];
    vscode.config.projectInitialized = true;
    vscode.workspaceState.set("rulesync.syncState.v1", { schemaVersion: 1, sourceIdentity: "github:acme/legacy:default:cursor-project", entries: { x: 1 } });
    const { instance } = controller();
    await instance.initialize();
    expect(instance.dashboardState().configured).toBe(false);
    expect(instance.dashboardState().folders.every((folder) => !folder.configured)).toBe(true);
    expect(instance.dashboardState().legacyWorkspaceSource).toEqual({ provider: "github", repository: "acme/legacy" });
    await instance.handle({ type: "workspace.source.assign", folderUri: beta.uri.toString() });
    expect(instance.dashboardState().selectedFolderUri).toBe(beta.uri.toString());
    expect(instance.dashboardState().configured).toBe(true);
    expect(instance.dashboardState().source?.repository).toBe("acme/legacy");
    expect(instance.dashboardState().folders.find((folder) => folder.uri === alpha.uri.toString())?.configured).toBe(false);
    expect(instance.dashboardState().legacyWorkspaceSource).toBeUndefined();
    expect(vscode.config.sources).toBeUndefined();
  });

  it("discards leftover workspace setup without configuring any folder", async () => {
    const alpha = workspaceFolder("/tmp/alpha", "alpha");
    const beta = workspaceFolder("/tmp/beta", "beta");
    vscode.setFolders([alpha, beta]);
    vscode.config.sources = [{ id: "team", provider: "github", repository: "acme/legacy", profile: "cursor-project", enabled: true }];
    const { instance } = controller();
    await instance.initialize();
    await instance.handle({ type: "workspace.source.discard" });
    expect(instance.dashboardState().folders.every((folder) => !folder.configured)).toBe(true);
    expect(instance.dashboardState().legacyWorkspaceSource).toBeUndefined();
    expect(vscode.config.sources).toBeUndefined();
  });

  it("propagates shared auth changes only to matching provider sessions", async () => {
    const alpha = workspaceFolder("/tmp/alpha", "alpha");
    const beta = workspaceFolder("/tmp/beta", "beta");
    vscode.setFolders([alpha, beta]);
    vscode.folderValues.set(alpha.uri.toString(), { projectInitialized: true, sources: [{ id: "team", provider: "github", repository: "acme/alpha", profile: "cursor-project", enabled: true }] });
    vscode.folderValues.set(beta.uri.toString(), { projectInitialized: true, sources: [{ id: "team", provider: "gitlab", repository: "group/beta", profile: "cursor-project", baseUrl: "https://gitlab.com", enabled: true }] });
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    vscode.secrets.set("rulesync.gitlab.pat.https%3A%2F%2Fgitlab.com", "glpat-test");
    const { instance } = controller();
    await instance.initialize();
    await instance.handle({ type: "gitlab.pat.forget", baseUrl: "https://gitlab.com" });
    expect(instance.dashboardState().source?.provider).toBe("github");
    expect(instance.dashboardState().statusMessage).not.toMatch(/GitLab/);
    await instance.handle({ type: "folder.select", folderUri: beta.uri.toString() });
    expect(instance.dashboardState().statusMessage).toMatch(/Paste a GitLab personal access token/);
  });

  it("keeps selected counts folder-local while the folder list exposes every pending count", async () => {
    const alpha = workspaceFolder("/tmp/alpha", "alpha");
    const beta = workspaceFolder("/tmp/beta", "beta");
    vscode.setFolders([alpha, beta]);
    vscode.folderValues.set(alpha.uri.toString(), { projectInitialized: true, sources: [{ id: "team", provider: "github", repository: "acme/alpha", profile: "cursor-project", enabled: true }] });
    vscode.folderValues.set(beta.uri.toString(), { projectInitialized: true, sources: [{ id: "team", provider: "github", repository: "acme/beta", profile: "cursor-project", enabled: true }] });
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    const incomingA = hashed(".cursor/rules/a.mdc", "remote-a");
    const incomingB = hashed(".cursor/rules/b.mdc", "remote-b");
    const github = provider({
      verifyRepository: async (repo) => ({ defaultBranch: "main", fullName: repo }),
      getTree: async (repo) => repo === "acme/alpha"
        ? [{ path: incomingA.path, oid: "a", mode: "file", size: incomingA.size }]
        : [{ path: incomingB.path, oid: "b", mode: "file", size: incomingB.size }],
      getBlob: async (_repo, oid) => oid === "a" ? incomingA.content ?? new Uint8Array() : incomingB.content ?? new Uint8Array()
    });
    const { context: extensionContext } = context();
    const instance = new RuleSyncController(extensionContext, {
      createGithub: () => github,
      listFiles: async () => [],
      watch: () => ({ on: () => undefined, close: () => undefined }) as never
    });
    await instance.initialize();
    await instance.refresh();
    await instance.handle({ type: "folder.select", folderUri: beta.uri.toString() });
    await instance.refresh();
    const state = instance.dashboardState();
    expect(state.incomingCount).toBe(1);
    expect(state.folders.reduce((total, folder) => total + folder.incomingCount, 0)).toBe(2);
  });

  it("opens distinct virtual documents for the same managed path in two folders", async () => {
    const alpha = workspaceFolder("/tmp/alpha", "alpha");
    const beta = workspaceFolder("/tmp/beta", "beta");
    vscode.setFolders([alpha, beta]);
    vscode.folderValues.set(alpha.uri.toString(), { projectInitialized: true, sources: [{ id: "team", provider: "github", repository: "acme/alpha", profile: "cursor-project", enabled: true }] });
    vscode.folderValues.set(beta.uri.toString(), { projectInitialized: true, sources: [{ id: "team", provider: "github", repository: "acme/beta", profile: "cursor-project", enabled: true }] });
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    const remote = hashed(".cursor/rules/shared.mdc", "remote");
    const github = provider({
      verifyRepository: async (repo) => ({ defaultBranch: "main", fullName: repo }),
      getTree: async () => [{ path: remote.path, oid: "r", mode: "file", size: remote.size }],
      getBlob: async () => remote.content ?? new Uint8Array()
    });
    const diffs: unknown[][] = [];
    vscode.commands.executeCommand = async (...args: unknown[]) => { diffs.push(args); };
    const { context: extensionContext } = context();
    const instance = new RuleSyncController(extensionContext, {
      createGithub: () => github,
      listFiles: async () => [],
      watch: () => ({ on: () => undefined, close: () => undefined }) as never
    });
    await instance.initialize();
    await instance.refresh();
    await instance.handle({ type: "content.diff", path: remote.path, comparison: "remote" });
    await instance.handle({ type: "folder.select", folderUri: beta.uri.toString() });
    await instance.refresh();
    await instance.handle({ type: "content.diff", path: remote.path, comparison: "remote" });
    const first = String((diffs[0] as { toString(): string }[])?.[1]);
    const second = String((diffs[1] as { toString(): string }[])?.[1]);
    expect(first).toContain(encodeURIComponent(alpha.uri.toString()));
    expect(second).toContain(encodeURIComponent(beta.uri.toString()));
    expect(first).not.toBe(second);
  });

  it("resolves disable, open, and publish against the selected folder root", async () => {
    const alpha = workspaceFolder("/tmp/alpha", "alpha");
    const beta = workspaceFolder("/tmp/beta", "beta");
    vscode.setFolders([alpha, beta]);
    vscode.folderValues.set(alpha.uri.toString(), { projectInitialized: true, sources: [{ id: "team", provider: "github", repository: "acme/alpha", profile: "cursor-project", enabled: true }] });
    vscode.folderValues.set(beta.uri.toString(), { projectInitialized: true, sources: [{ id: "team", provider: "github", repository: "acme/beta", profile: "cursor-project", enabled: true }] });
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    const remote = hashed(".cursor/rules/foo.mdc", "same");
    vscode.workspaceState.set(`rulesync.syncState.v1:${encodeURIComponent(beta.uri.toString())}`, { schemaVersion: 1, sourceIdentity: "github:acme/beta:default:cursor-project", entries: { [remote.path]: { localHash: remote.contentHash, remoteOid: remote.contentHash, mode: "file" } } });
    const local = hashed(".cursor/rules/foo.mdc", "changed");
    const files = new Map<string, FileEntry[]>([[alpha.uri.fsPath, [{ ...remote, content: new Uint8Array(remote.content ?? new Uint8Array()) }]], [beta.uri.fsPath, [{ ...local, content: new Uint8Array(local.content ?? new Uint8Array()) }]]]);
    const roots: string[] = [];
    let published = false;
    const github = connectedRemote(remote, {
      createProposal: async (input) => {
        published = true;
        expect(input.changes.map((change) => change.path)).toEqual([local.path]);
        expect(input.repository).toBe("acme/beta");
        return { branch: "rulesync/ada/1", headCommit: "def", compareUrl: "https://github.com/acme/beta/compare/main...x" };
      }
    });
    const { context: extensionContext } = context();
    const instance = new RuleSyncController(extensionContext, {
      createGithub: () => github,
      listFiles: async (root) => files.get(root)?.map((entry) => ({ ...entry, content: entry.content ? new Uint8Array(entry.content) : new Uint8Array() })) ?? [],
      renameFile: async (root, previous, next) => {
        roots.push(root);
        const current = files.get(root) ?? [];
        const index = current.findIndex((item) => item.path === previous);
        if (index === -1) throw new Error(`missing ${previous}`);
        current[index] = { ...current[index]!, path: next };
        files.set(root, current);
      },
      writeFile: async () => undefined,
      removeFile: async () => undefined,
      watch: () => ({ on: () => undefined, close: () => undefined }) as never
    });
    const opened: string[] = [];
    vscode.window.showTextDocument = async (uri?: { fsPath: string }) => { if (uri) opened.push(uri.fsPath); };
    await instance.initialize();
    await instance.handle({ type: "folder.select", folderUri: beta.uri.toString() });
    await instance.refresh();
    await instance.handle({ type: "content.disable", path: local.path });
    expect(roots).toEqual([beta.uri.fsPath]);
    await instance.handle({ type: "content.open", path: local.path });
    expect(opened.some((value) => value.startsWith(beta.uri.fsPath))).toBe(true);
    await instance.handle({ type: "content.enable", path: local.path });
    await instance.handle({ type: "proposal.publish", message: "update foo" });
    expect(published).toBe(true);
  });

  function twoGithubFolders() {
    const alpha = workspaceFolder("/tmp/alpha", "alpha");
    const beta = workspaceFolder("/tmp/beta", "beta");
    vscode.setFolders([alpha, beta]);
    vscode.folderValues.set(alpha.uri.toString(), { projectInitialized: true, sources: [{ id: "team", provider: "github", repository: "acme/alpha", profile: "cursor-project", enabled: true }] });
    vscode.folderValues.set(beta.uri.toString(), { projectInitialized: true, sources: [{ id: "team", provider: "github", repository: "acme/beta", profile: "cursor-project", enabled: true }] });
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    const verified: string[] = [];
    const github = provider({
      verifyRepository: async (repo) => { verified.push(repo); return { defaultBranch: "main", fullName: repo }; },
      getRef: async (repo) => repo
    });
    return { alpha, beta, verified, github };
  }

  it("checks every configured folder on focus", async () => {
    vscode.config["updateCheck.mode"] = "both";
    vscode.config["updateCheck.onStart"] = false;
    vscode.config["updateCheck.onFocus"] = true;
    const { verified, github } = twoGithubFolders();
    const { context: extensionContext } = context();
    const instance = new RuleSyncController(extensionContext, {
      createGithub: () => github,
      listFiles: async () => [],
      watch: () => ({ on: () => undefined, close: () => undefined }) as never
    });
    await instance.initialize();
    expect(verified).toEqual([]);
    vscode.fireFocus();
    await vi.waitFor(() => { expect([...verified].sort()).toEqual(["acme/alpha", "acme/beta"]); });
  });

  it("checks only the selected folder when the dashboard opens", async () => {
    vscode.config["updateCheck.mode"] = "both";
    vscode.config["updateCheck.onStart"] = false;
    vscode.config["updateCheck.onDashboardOpen"] = true;
    const { verified, github } = twoGithubFolders();
    const { context: extensionContext } = context();
    const instance = new RuleSyncController(extensionContext, {
      createGithub: () => github,
      listFiles: async () => [],
      watch: () => ({ on: () => undefined, close: () => undefined }) as never
    });
    await instance.initialize();
    await instance.handle({ type: "ready" });
    await vi.waitFor(() => { expect(verified).toEqual(["acme/alpha"]); });
  });

  it("checks every configured folder on the coordinator timer", async () => {
    vscode.config["updateCheck.mode"] = "timed";
    vscode.config["updateCheck.onStart"] = false;
    const { verified, github } = twoGithubFolders();
    const { context: extensionContext } = context();
    vi.useFakeTimers();
    const instance = new RuleSyncController(extensionContext, {
      createGithub: () => github,
      listFiles: async () => [],
      watch: () => ({ on: () => undefined, close: () => undefined }) as never
    });
    await instance.initialize();
    expect(verified).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect([...verified].sort()).toEqual(["acme/alpha", "acme/beta"]);
    vi.useRealTimers();
    instance.dispose();
  });

  it("omits non-file roots from sessions and never reads them", async () => {
    const local = workspaceFolder("/tmp/alpha", "alpha");
    const remote = { name: "remote", index: 1, uri: { scheme: "vscode-remote", fsPath: "/remote/project", toString: () => "vscode-remote://host/remote/project" } };
    vscode.setFolders([local, remote]);
    vscode.config.sources = [{ id: "team", provider: "github", repository: "acme/legacy", profile: "cursor-project", enabled: true }];
    const roots: string[] = [];
    const { context: extensionContext } = context();
    const instance = new RuleSyncController(extensionContext, {
      listFiles: async (root) => { roots.push(root); return []; },
      watch: () => ({ on: () => undefined, close: () => undefined }) as never
    });
    await instance.initialize();
    expect(instance.dashboardState().folders.map((folder) => folder.uri)).toEqual([local.uri.toString()]);
    expect(instance.dashboardState().configured).toBe(false);
    expect(instance.dashboardState().legacyWorkspaceSource).toEqual({ provider: "github", repository: "acme/legacy" });
    expect(roots).toEqual([local.uri.fsPath]);
  });

  it("keeps an in-flight mutate on the folder captured when handle started", async () => {
    const alpha = workspaceFolder("/tmp/alpha", "alpha");
    const beta = workspaceFolder("/tmp/beta", "beta");
    vscode.setFolders([alpha, beta]);
    vscode.folderValues.set(alpha.uri.toString(), { projectInitialized: true, sources: [{ id: "team", provider: "github", repository: "acme/alpha", profile: "cursor-project", enabled: true }] });
    vscode.folderValues.set(beta.uri.toString(), { projectInitialized: true, sources: [{ id: "team", provider: "github", repository: "acme/beta", profile: "cursor-project", enabled: true }] });
    vscode.secrets.set("rulesync.github.accessToken", "gho-test");
    const shared = hashed(".cursor/rules/foo.mdc", "same");
    const files = new Map<string, FileEntry[]>([[alpha.uri.fsPath, [{ ...shared, content: new Uint8Array(shared.content ?? new Uint8Array()) }]], [beta.uri.fsPath, [{ ...shared, content: new Uint8Array(shared.content ?? new Uint8Array()) }]]]);
    const rename = deferred<void>();
    const roots: string[] = [];
    const { context: extensionContext } = context();
    const instance = new RuleSyncController(extensionContext, {
      createGithub: () => connectedRemote(shared),
      listFiles: async (root) => files.get(root)?.map((entry) => ({ ...entry, content: entry.content ? new Uint8Array(entry.content) : new Uint8Array() })) ?? [],
      renameFile: async (root, previous, next) => {
        roots.push(root);
        await rename.promise;
        const current = files.get(root) ?? [];
        const index = current.findIndex((item) => item.path === previous);
        if (index === -1) throw new Error(`missing ${previous}`);
        current[index] = { ...current[index]!, path: next };
        files.set(root, current);
      },
      writeFile: async () => undefined,
      removeFile: async () => undefined,
      watch: () => ({ on: () => undefined, close: () => undefined }) as never
    });
    await instance.initialize();
    const pending = instance.handle({ type: "content.disable", path: shared.path });
    await instance.handle({ type: "folder.select", folderUri: beta.uri.toString() });
    rename.resolve();
    await pending;
    expect(roots).toEqual([alpha.uri.fsPath]);
    expect(instance.dashboardState().selectedFolderUri).toBe(beta.uri.toString());
  });
});
