import { beforeEach, describe, expect, it, vi } from "vitest";

const vscode = vi.hoisted(() => {
  const workspaceValue: Record<string, unknown> = {};
  const folderValues = new Map<string, Record<string, unknown>>();
  const workspaceState = new Map<string, unknown>();
  return {
    workspaceValue,
    folderValues,
    workspaceState,
    folders: [] as Array<{ uri: { scheme: string; toString: () => string } }>,
    reset() {
      for (const key of Object.keys(workspaceValue)) delete workspaceValue[key];
      folderValues.clear();
      workspaceState.clear();
      this.folders = [];
    },
    ConfigurationTarget: { Workspace: 1, WorkspaceFolder: 3 },
    workspace: {
      get workspaceFolders() { return vscode.folders; },
      getConfiguration: (_section?: string, resource?: { toString: () => string }) => ({
        inspect: <T>(key: string) => ({ workspaceValue: workspaceValue[key] as T | undefined, workspaceFolderValue: resource ? folderValues.get(resource.toString())?.[key] as T | undefined : undefined }),
        update: async (key: string, value: unknown, target: number) => {
          if (target === 3 && resource) {
            const next = { ...folderValues.get(resource.toString()) ?? {} };
            if (value === undefined) delete next[key];
            else next[key] = value;
            folderValues.set(resource.toString(), next);
            return;
          }
          if (value === undefined) delete workspaceValue[key];
          else workspaceValue[key] = value;
        }
      })
    }
  };
});

vi.mock("vscode", () => vscode);

import { assignLegacyWorkspaceSetup, discardLegacyWorkspaceSetup, eligibleFolders, hasLegacyWorkspaceSetup, migrateSingleFolderState, readFolderSources, writeFolderSetting } from "./folderConfig.js";

function folder(uri: string): { uri: { scheme: "file"; toString: () => string } } {
  return { uri: { scheme: "file", toString: () => uri } };
}

function context(): { workspaceState: { get: <T>(key: string) => T | undefined; update: (key: string, value: unknown) => Promise<void> } } {
  return {
    workspaceState: {
      get: <T>(key: string) => vscode.workspaceState.get(key) as T | undefined,
      update: async (key: string, value: unknown) => { if (value === undefined) vscode.workspaceState.delete(key); else vscode.workspaceState.set(key, value); }
    }
  };
}

describe("folderConfig", () => {
  beforeEach(() => vscode.reset());

  it("reads workspace sources only for a single folder", () => {
    vscode.workspaceValue.sources = [{ id: "team", provider: "github", repository: "acme/rules", profile: "cursor-project" }];
    vscode.folders = [folder("file:///a")];
    expect(readFolderSources(vscode.folders[0] as never)).toHaveLength(1);
    vscode.folders = [folder("file:///a"), folder("file:///b")];
    expect(readFolderSources(vscode.folders[0] as never)).toEqual([]);
    expect(hasLegacyWorkspaceSetup()).toBe(true);
    vscode.folders = [folder("file:///a"), { uri: { scheme: "vscode-remote", toString: () => "vscode-remote://host/b" } }];
    expect(readFolderSources(vscode.folders[0] as never)).toEqual([]);
  });

  it("assigns legacy workspace setup to one folder", async () => {
    vscode.workspaceValue.sources = [{ id: "team", provider: "github", repository: "acme/rules", profile: "cursor-project" }];
    vscode.workspaceValue.projectInitialized = true;
    vscode.workspaceState.set("rulesync.syncState.v1", { schemaVersion: 1, sourceIdentity: "github:acme/rules:default:cursor-project", entries: {} });
    vscode.folders = [folder("file:///a"), folder("file:///b")];
    await assignLegacyWorkspaceSetup(context() as never, vscode.folders[0] as never);
    expect(readFolderSources(vscode.folders[0] as never)[0]?.repository).toBe("acme/rules");
    expect(readFolderSources(vscode.folders[1] as never)).toEqual([]);
    expect(vscode.workspaceValue.sources).toBeUndefined();
    expect(vscode.workspaceState.get("rulesync.syncState.v1")).toBeUndefined();
    expect(vscode.workspaceState.get(`rulesync.syncState.v1:${encodeURIComponent("file:///a")}`)).toBeTruthy();
  });

  it("discards legacy workspace setup without writing folder settings", async () => {
    vscode.workspaceValue.sources = [{ id: "team", provider: "github", repository: "acme/rules", profile: "cursor-project" }];
    vscode.folders = [folder("file:///a"), folder("file:///b")];
    await discardLegacyWorkspaceSetup(context() as never);
    expect(vscode.workspaceValue.sources).toBeUndefined();
    expect(readFolderSources(vscode.folders[0] as never)).toEqual([]);
    expect(readFolderSources(vscode.folders[1] as never)).toEqual([]);
  });

  it("migrates unscoped state onto the only folder", async () => {
    vscode.folders = [folder("file:///a")];
    vscode.workspaceState.set("rulesync.syncState.v1", { schemaVersion: 1, sourceIdentity: "github:acme/rules:default:cursor-project", entries: { x: 1 } });
    vscode.workspaceState.set("rulesync.gitlab.baseUrl", "https://gitlab.com");
    await migrateSingleFolderState(context() as never, vscode.folders[0] as never);
    expect(vscode.workspaceState.get("rulesync.syncState.v1")).toBeUndefined();
    expect(vscode.workspaceState.get(`rulesync.syncState.v1:${encodeURIComponent("file:///a")}`)).toEqual({ schemaVersion: 1, sourceIdentity: "github:acme/rules:default:cursor-project", entries: { x: 1 } });
    expect(eligibleFolders()[0]?.uri.toString()).toBe("file:///a");
  });

  it("writes single-folder settings to workspace scope", async () => {
    vscode.folders = [folder("file:///a")];
    await writeFolderSetting(vscode.folders[0] as never, "projectInitialized", true);
    expect(vscode.workspaceValue.projectInitialized).toBe(true);
    expect(vscode.folderValues.get("file:///a")).toBeUndefined();
  });

  it("writes multi-root settings to the folder scope", async () => {
    vscode.folders = [folder("file:///a"), folder("file:///b")];
    await writeFolderSetting(vscode.folders[0] as never, "projectInitialized", true);
    expect(vscode.folderValues.get("file:///a")?.projectInitialized).toBe(true);
    expect(vscode.workspaceValue.projectInitialized).toBeUndefined();
  });
});
