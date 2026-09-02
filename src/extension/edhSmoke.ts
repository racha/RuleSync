import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import assert from "node:assert/strict";

import type { RuleSyncController } from "./controller.js";

async function loadController(): Promise<RuleSyncController> {
  const extension = vscode.extensions.getExtension<{ controller: RuleSyncController }>("INVEON-Development.rulesync");
  assert.ok(extension, "RuleSync extension is missing");
  const api = extension.isActive ? extension.exports : await extension.activate();
  assert.ok(api?.controller, "RuleSync controller is missing");
  return api.controller;
}

function fileFolders(): vscode.WorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).filter(({ uri }) => uri.scheme === "file");
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function runUntrusted(controller: RuleSyncController, folders: vscode.WorkspaceFolder[]): Promise<void> {
  const [alpha, beta] = folders;
  assert.ok(alpha && beta);
  const state = controller.dashboardState();
  assert.equal(state.trusted, false);
  assert.equal(state.items.length, 0);
  assert.ok(state.folders.every(({ uri }) => uri.startsWith("file:")));
  await controller.handle({ type: "folder.select", folderUri: beta.uri.toString() });
  assert.equal(controller.dashboardState().selectedFolderUri, beta.uri.toString());
  await assert.rejects(controller.handle({ type: "workspace.source.assign", folderUri: beta.uri.toString() }), /Trust this workspace/);
  await assert.rejects(controller.handle({ type: "content.open", path: ".cursor/rules/shared.mdc" }), /Trust this workspace/);
}

async function runSingle(controller: RuleSyncController, folder: vscode.WorkspaceFolder): Promise<void> {
  const state = controller.dashboardState();
  assert.equal(state.trusted, true);
  assert.equal(state.folders.length, 1);
  assert.equal(state.folders[0]?.uri, folder.uri.toString());
  assert.equal(state.workspaceName, folder.name);
  assert.equal(state.configured, true);
  assert.equal(state.source?.repository, "acme/single");
  assert.equal(state.legacyWorkspaceSource, undefined);
  assert.ok(state.items.some(({ path: itemPath }) => itemPath === ".cursor/rules/shared.mdc"));
  await controller.handle({ type: "sync.refresh" });
  await controller.handle({ type: "content.disable", path: ".cursor/rules/shared.mdc" });
  assert.equal(controller.dashboardState().items.find(({ path: itemPath }) => itemPath === ".cursor/rules/shared.mdc")?.disabled, true);
  assert.ok(fs.existsSync(path.join(folder.uri.fsPath, ".cursor/rules/shared.mdc.off")));
  await controller.handle({ type: "content.create", request: { type: "rule", name: "local-only-smoke", localOnly: true } });
  assert.equal(controller.dashboardState().items.find(({ path: itemPath }) => itemPath === ".cursor/rules/local-only-smoke.mdc")?.localOnly, true);
  assert.ok(fs.existsSync(path.join(folder.uri.fsPath, ".cursor/rules/local-only-smoke.mdc")));
  assert.ok(!fs.existsSync(path.join(folder.uri.fsPath, ".cursor/.rulesync-local.json")));
}

async function runMulti(controller: RuleSyncController, folders: vscode.WorkspaceFolder[]): Promise<void> {
  const [alpha, beta] = folders;
  assert.ok(alpha && beta);
  let state = controller.dashboardState();
  assert.equal(state.trusted, true);
  assert.equal(state.folders.length, folders.length);
  assert.ok(state.folders.every(({ uri }) => uri.startsWith("file:")));
  assert.equal(state.legacyWorkspaceSource?.repository, "acme/legacy");
  assert.equal(state.configured, false);
  assert.ok(state.folders.every(({ configured }) => !configured));

  await controller.handle({ type: "workspace.source.assign", folderUri: beta.uri.toString() });
  state = controller.dashboardState();
  assert.equal(state.selectedFolderUri, beta.uri.toString());
  assert.equal(state.configured, true);
  assert.equal(state.source?.repository, "acme/legacy");
  assert.equal(state.folders.find(({ uri }) => uri === alpha.uri.toString())?.configured, false);
  assert.equal(state.legacyWorkspaceSource, undefined);

  await vscode.workspace.getConfiguration("rulesync", alpha.uri).update("sources", [{ id: "team", provider: "github", repository: "acme/alpha", profile: "cursor-project", enabled: true }], vscode.ConfigurationTarget.WorkspaceFolder);
  await vscode.workspace.getConfiguration("rulesync", alpha.uri).update("projectInitialized", true, vscode.ConfigurationTarget.WorkspaceFolder);
  await waitFor(() => controller.dashboardState().folders.find(({ uri }) => uri === alpha.uri.toString())?.configured === true, "alpha did not configure independently");
  assert.equal(controller.dashboardState().source?.repository, "acme/legacy");

  await controller.handle({ type: "folder.select", folderUri: alpha.uri.toString() });
  state = controller.dashboardState();
  assert.equal(state.workspaceName, alpha.name);
  assert.equal(state.source?.repository, "acme/alpha");
  assert.ok(state.items.some(({ path: itemPath }) => itemPath === ".cursor/rules/shared.mdc"));

  await controller.handle({ type: "folder.select", folderUri: beta.uri.toString() });
  state = controller.dashboardState();
  assert.equal(state.workspaceName, beta.name);
  assert.ok(state.items.some(({ path: itemPath }) => itemPath === ".cursor/rules/shared.mdc"));
  await controller.handle({ type: "content.open", path: ".cursor/rules/shared.mdc" });
  const opened = vscode.window.visibleTextEditors.some((editor) => editor.document.uri.fsPath.startsWith(beta.uri.fsPath) && editor.document.uri.fsPath.endsWith(".cursor/rules/shared.mdc"));
  assert.ok(opened || fs.existsSync(path.join(beta.uri.fsPath, ".cursor/rules/shared.mdc")));
  await controller.handle({ type: "content.disable", path: ".cursor/rules/shared.mdc" });
  state = controller.dashboardState();
  assert.equal(state.items.find(({ path: itemPath }) => itemPath === ".cursor/rules/shared.mdc")?.disabled, true);
  assert.ok(fs.existsSync(path.join(beta.uri.fsPath, ".cursor/rules/shared.mdc.off")));
  assert.ok(fs.existsSync(path.join(alpha.uri.fsPath, ".cursor/rules/shared.mdc")));
  const selectedPending = state.incomingCount + state.localCount + state.conflictCount;
  const aggregate = state.folders.reduce((total, { incomingCount, localCount, conflictCount }) => total + incomingCount + localCount + conflictCount, 0);
  assert.ok(aggregate >= selectedPending);
  assert.equal(state.folders.filter(({ configured }) => configured).length, 2);

  const pending = controller.handle({ type: "sync.refresh" });
  await controller.handle({ type: "folder.select", folderUri: alpha.uri.toString() });
  await pending;
  assert.equal(controller.dashboardState().selectedFolderUri, alpha.uri.toString());
  assert.ok(fs.existsSync(path.join(beta.uri.fsPath, ".cursor/rules/shared.mdc.off")));

  const gammaPath = path.join(path.dirname(alpha.uri.fsPath), "gamma");
  fs.mkdirSync(path.join(gammaPath, ".cursor/rules"), { recursive: true });
  const added = vscode.workspace.updateWorkspaceFolders(fileFolders().length, 0, { uri: vscode.Uri.file(gammaPath), name: "gamma" });
  assert.ok(added);
  await waitFor(() => controller.dashboardState().folders.some(({ name }) => name === "gamma"), "added folder did not appear");
  assert.equal(controller.dashboardState().selectedFolderUri, alpha.uri.toString());
  assert.equal(controller.dashboardState().folders.find(({ name }) => name === "gamma")?.configured, false);

  const selected = fileFolders().find(({ uri }) => uri.toString() === controller.dashboardState().selectedFolderUri);
  assert.ok(selected);
  const removed = vscode.workspace.updateWorkspaceFolders(selected.index, 1);
  assert.ok(removed);
  await waitFor(() => controller.dashboardState().selectedFolderUri !== selected.uri.toString(), "removed folder remained selected");
  assert.ok(controller.dashboardState().folders.every(({ uri }) => uri !== selected.uri.toString()));
}

export async function run(): Promise<void> {
  const controller = await loadController();
  const folders = fileFolders();
  if (!vscode.workspace.isTrusted) {
    assert.ok(folders.length >= 2, "untrusted EDH smoke needs two local folders");
    await runUntrusted(controller, folders);
    return;
  }
  if (folders.length === 1) {
    await runSingle(controller, folders[0]!);
    return;
  }
  assert.ok(folders.length >= 2, "multi-root EDH smoke needs two local folders");
  await runMulti(controller, folders);
}
