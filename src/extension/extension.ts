import * as vscode from "vscode";
import { RuleSyncController } from "./controller.js";
import { RuleSyncDashboardProvider } from "./dashboardProvider.js";

export async function activate(context: vscode.ExtensionContext): Promise<{ controller: RuleSyncController }> {
  const controller = new RuleSyncController(context);
  const dashboard = new RuleSyncDashboardProvider(context, controller);
  context.subscriptions.push(controller, dashboard);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("rulesync.dashboard", dashboard, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.commands.registerCommand("rulesync.refresh", () => controller.handle({ type: "sync.refresh" })));
  context.subscriptions.push(vscode.commands.registerCommand("rulesync.connect", () => vscode.commands.executeCommand("workbench.view.extension.rulesync")));
  context.subscriptions.push(vscode.commands.registerCommand("rulesync.openDashboard", () => vscode.commands.executeCommand("workbench.view.extension.rulesync")));
  await controller.initialize();
  return { controller };
}

export function deactivate(): void {}
