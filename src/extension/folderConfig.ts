import * as vscode from "vscode";
import { configuredSource, type SourceSpec, type SyncState } from "@rulesync/core";

export const legacyStateKey = "rulesync.syncState.v1";
export const legacyGitlabBaseUrlKey = "rulesync.gitlab.baseUrl";
export const selectedFolderKey = "rulesync.selectedFolderUri.v1";
export const legacyAssignmentKey = "rulesync.legacyWorkspaceSource.v1";

export interface LegacyAssignment {
  status: "pending" | "assigned" | "discarded";
  folderUri?: string;
}

export interface FolderOptOut {
  source: string;
  paths: string[];
}

export function eligibleFolders(folders = vscode.workspace.workspaceFolders): vscode.WorkspaceFolder[] {
  return (folders ?? []).filter((folder) => folder.uri.scheme === "file");
}

export function folderUri(folder: vscode.WorkspaceFolder): string {
  return folder.uri.toString();
}

export function folderStateKey(uri: string): string {
  return `${legacyStateKey}:${encodeURIComponent(uri)}`;
}

export function folderGitlabBaseUrlKey(uri: string): string {
  return `${legacyGitlabBaseUrlKey}:${encodeURIComponent(uri)}`;
}

export function isMultiRoot(folders = vscode.workspace.workspaceFolders): boolean {
  return (folders?.length ?? 0) > 1;
}

function inspectFolder<T>(folder: vscode.WorkspaceFolder, key: string): { workspaceValue?: T; workspaceFolderValue?: T } {
  return vscode.workspace.getConfiguration("rulesync", folder.uri).inspect<T>(key) ?? {};
}

export function readFolderSources(folder: vscode.WorkspaceFolder): SourceSpec[] {
  const { workspaceValue, workspaceFolderValue } = inspectFolder<SourceSpec[]>(folder, "sources");
  if (isMultiRoot()) return workspaceFolderValue ?? [];
  return workspaceFolderValue ?? workspaceValue ?? [];
}

export function readFolderInitialized(folder: vscode.WorkspaceFolder): boolean {
  const { workspaceValue, workspaceFolderValue } = inspectFolder<boolean>(folder, "projectInitialized");
  if (isMultiRoot()) return workspaceFolderValue ?? false;
  return workspaceFolderValue ?? workspaceValue ?? false;
}

export function readFolderOptOut(folder: vscode.WorkspaceFolder): FolderOptOut[] {
  const { workspaceValue, workspaceFolderValue } = inspectFolder<FolderOptOut[]>(folder, "optOut");
  if (isMultiRoot()) return workspaceFolderValue ?? [];
  return workspaceFolderValue ?? workspaceValue ?? [];
}

export async function writeFolderSetting(folder: vscode.WorkspaceFolder, key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration("rulesync", folder.uri).update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
}

export function inspectWorkspaceSources(): SourceSpec[] | undefined {
  return vscode.workspace.getConfiguration("rulesync").inspect<SourceSpec[]>("sources")?.workspaceValue;
}

export function inspectWorkspaceInitialized(): boolean | undefined {
  return vscode.workspace.getConfiguration("rulesync").inspect<boolean>("projectInitialized")?.workspaceValue;
}

export function inspectWorkspaceOptOut(): FolderOptOut[] | undefined {
  return vscode.workspace.getConfiguration("rulesync").inspect<FolderOptOut[]>("optOut")?.workspaceValue;
}

export function hasLegacyWorkspaceSetup(): boolean {
  return Boolean(configuredSource(inspectWorkspaceSources() ?? []) || inspectWorkspaceInitialized() || inspectWorkspaceOptOut()?.length);
}

export function readLegacyAssignment(context: vscode.ExtensionContext): LegacyAssignment | undefined {
  return context.workspaceState.get<LegacyAssignment>(legacyAssignmentKey);
}

export async function writeLegacyAssignment(context: vscode.ExtensionContext, next: LegacyAssignment | undefined): Promise<void> {
  await context.workspaceState.update(legacyAssignmentKey, next);
}

export async function migrateSingleFolderState(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder): Promise<void> {
  const uri = folderUri(folder);
  const namespaced = context.workspaceState.get<SyncState>(folderStateKey(uri));
  const legacy = context.workspaceState.get<SyncState>(legacyStateKey);
  if (!namespaced && legacy) {
    await context.workspaceState.update(folderStateKey(uri), legacy);
    await context.workspaceState.update(legacyStateKey, undefined);
  }
  const namespacedHost = context.workspaceState.get<string>(folderGitlabBaseUrlKey(uri));
  const legacyHost = context.workspaceState.get<string>(legacyGitlabBaseUrlKey);
  if (!namespacedHost && legacyHost) {
    await context.workspaceState.update(folderGitlabBaseUrlKey(uri), legacyHost);
    await context.workspaceState.update(legacyGitlabBaseUrlKey, undefined);
  }
  const { workspaceValue: sources, workspaceFolderValue: folderSources } = inspectFolder<SourceSpec[]>(folder, "sources");
  if (!folderSources?.length && sources?.length) await writeFolderSetting(folder, "sources", sources);
  const { workspaceValue: initialized, workspaceFolderValue: folderInitialized } = inspectFolder<boolean>(folder, "projectInitialized");
  if (folderInitialized === undefined && initialized !== undefined) await writeFolderSetting(folder, "projectInitialized", initialized);
  const { workspaceValue: optOut, workspaceFolderValue: folderOptOut } = inspectFolder<FolderOptOut[]>(folder, "optOut");
  if (folderOptOut === undefined && optOut !== undefined) await writeFolderSetting(folder, "optOut", optOut);
}

export async function clearWorkspaceLevelSetup(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("rulesync");
  await cfg.update("sources", undefined, vscode.ConfigurationTarget.Workspace);
  await cfg.update("projectInitialized", undefined, vscode.ConfigurationTarget.Workspace);
  await cfg.update("optOut", undefined, vscode.ConfigurationTarget.Workspace);
}

export async function assignLegacyWorkspaceSetup(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder): Promise<void> {
  const uri = folderUri(folder);
  const sources = inspectWorkspaceSources();
  const initialized = inspectWorkspaceInitialized();
  const optOut = inspectWorkspaceOptOut();
  if (sources !== undefined) await writeFolderSetting(folder, "sources", sources);
  if (initialized !== undefined) await writeFolderSetting(folder, "projectInitialized", initialized);
  if (optOut !== undefined) await writeFolderSetting(folder, "optOut", optOut);
  const namespaced = context.workspaceState.get<SyncState>(folderStateKey(uri));
  const legacy = context.workspaceState.get<SyncState>(legacyStateKey);
  if (!namespaced && legacy) await context.workspaceState.update(folderStateKey(uri), legacy);
  const namespacedHost = context.workspaceState.get<string>(folderGitlabBaseUrlKey(uri));
  const legacyHost = context.workspaceState.get<string>(legacyGitlabBaseUrlKey);
  if (!namespacedHost && legacyHost) await context.workspaceState.update(folderGitlabBaseUrlKey(uri), legacyHost);
  await context.workspaceState.update(legacyStateKey, undefined);
  await context.workspaceState.update(legacyGitlabBaseUrlKey, undefined);
  await clearWorkspaceLevelSetup();
  await writeLegacyAssignment(context, { status: "assigned", folderUri: uri });
}

export async function discardLegacyWorkspaceSetup(context: vscode.ExtensionContext): Promise<void> {
  await context.workspaceState.update(legacyStateKey, undefined);
  await context.workspaceState.update(legacyGitlabBaseUrlKey, undefined);
  await clearWorkspaceLevelSetup();
  await writeLegacyAssignment(context, { status: "discarded" });
}
