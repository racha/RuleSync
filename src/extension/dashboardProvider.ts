import path from "node:path";
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { aggregatePendingBadge, type DashboardState } from "@rulesync/core";

import { commandSchema } from "./schemas.js";
import { RuleSyncController } from "./controller.js";
import type { DashboardCommand, DashboardEvent } from "./protocol.js";

export class RuleSyncDashboardProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  #view: vscode.WebviewView | undefined;
  readonly #subscriptions: vscode.Disposable[];

  constructor(private readonly context: vscode.ExtensionContext, private readonly controller: RuleSyncController) {
    this.#subscriptions = [controller.onDidChange((state) => {
      this.post({ type: "state.replace", state });
      this.badge(state);
    })];
  }

  dispose(): void { this.#subscriptions.forEach((subscription) => subscription.dispose()); }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview")] };
    view.onDidDispose(() => { if (this.#view === view) this.#view = undefined; }, undefined, this.#subscriptions);
    this.badge(this.controller.dashboardState());
    const render = () => { view.webview.html = this.html(view.webview); };
    render();
    view.webview.onDidReceiveMessage(async (message: unknown) => {
      const parsed = commandSchema.safeParse(message);
      if (!parsed.success) {
        this.post({ type: "operation.error", message: "RuleSync rejected an invalid dashboard request." });
        return;
      }
      try {
        await this.controller.handle(parsed.data as DashboardCommand);
        this.post({ type: "operation.done", command: parsed.data.type });
      } catch (error) { this.post({ type: "operation.error", message: error instanceof Error ? error.message : "RuleSync could not complete that action." }); }
    }, undefined, this.#subscriptions);
  }

  private post(event: DashboardEvent): void { void this.#view?.webview.postMessage(event); }

  private badge(state: DashboardState): void {
    if (!this.#view) return;
    this.#view.badge = aggregatePendingBadge(state.folders) ?? { value: 0, tooltip: "" };
  }

  private html(webview: vscode.Webview): string {
    const directory = path.join(this.context.extensionPath, "dist", "webview", "assets");
    const files = existsSync(directory) ? readdirSync(directory) : [];
    const js = files.find((file) => file === "webview.js") ?? files.find((file) => file.endsWith(".js") && !file.endsWith(".map"));
    const css = files.find((file) => file === "webview.css") ?? files.find((file) => file.endsWith(".css"));
    const nonce = randomBytes(16).toString("hex");
    if (!js) {
      return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none';"></head><body>RuleSync dashboard assets are missing. Run the extension build.</body></html>`;
    }
    const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(directory, js)));
    const stylesheet = css ? `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.file(path.join(directory, css)))}">` : "";
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  ${stylesheet}
  <title>RuleSync</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
