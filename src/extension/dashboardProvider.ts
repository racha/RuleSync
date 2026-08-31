import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { z } from "zod";
import { pendingBadge, type DashboardState } from "@rulesync/core";

import { RuleSyncController } from "./controller.js";
import type { DashboardCommand, DashboardEvent } from "./protocol.js";

const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("auth.start") }),
  z.object({ type: z.literal("github.app.create") }),
  z.object({ type: z.literal("github.app.install") }),
  z.object({ type: z.literal("github.app.help") }),
  z.object({ type: z.literal("workspace.initialize") }),
  z.object({ type: z.literal("manifest.initialize") }),
  z.object({ type: z.literal("github.clientId.save"), clientId: z.string().min(4).max(200) }),
  z.object({ type: z.literal("github.repos.refresh") }),
  z.object({ type: z.literal("sync.refresh") }),
  z.object({ type: z.literal("content.open"), path: z.string().min(1) }),
  z.object({ type: z.literal("content.diff"), path: z.string().min(1), comparison: z.enum(["remote", "base"]) }),
  z.object({ type: z.literal("content.rename"), path: z.string().min(1) }),
  z.object({ type: z.literal("content.delete"), path: z.string().min(1) }),
  z.object({ type: z.literal("content.revert"), path: z.string().min(1) }),
  z.object({ type: z.literal("conflict.resolve"), path: z.string().min(1), resolution: z.enum(["local", "remote"]) }),
  z.object({ type: z.literal("remote.apply"), path: z.string().min(1) }),
  z.object({ type: z.literal("remote.applyAll") }),
  z.object({ type: z.literal("risks.accept") }),
  z.object({ type: z.literal("proposal.publish"), message: z.string().max(300) }),
  z.object({ type: z.literal("proposal.openCompare") }),
  z.object({ type: z.literal("settings.open") }),
  z.object({ type: z.literal("settings.updateCheck"), settings: z.object({ mode: z.enum(["off", "timed", "events", "both"]), interval: z.enum(["hourly", "daily", "weekly"]), onStart: z.boolean(), onFocus: z.boolean(), onDashboardOpen: z.boolean() }) }),
  z.object({ type: z.literal("source.disconnect") }),
  z.object({ type: z.literal("source.save"), source: z.object({ id: z.string().min(1), provider: z.literal("github"), repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), ref: z.string().optional(), profile: z.string().min(1), enabled: z.boolean().optional() }) }),
  z.object({ type: z.literal("content.create"), request: z.object({ type: z.enum(["rule", "hook", "skill", "agent", "command", "mcp", "configuration", "other"]), name: z.string().min(1).max(100), description: z.string().max(500).optional(), ruleMode: z.enum(["always", "auto", "agent", "manual"]).optional(), globs: z.string().max(200).optional(), relativePath: z.string().max(300).optional() }) })
]);

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
    view.onDidChangeVisibility(() => { if (view.visible) render(); }, undefined, this.#subscriptions);
    view.webview.onDidReceiveMessage(async (message: unknown) => {
      const parsed = commandSchema.safeParse(message);
      if (!parsed.success) {
        this.post({ type: "operation.error", message: "RuleSync rejected an invalid dashboard request." });
        return;
      }
      try { await this.controller.handle(parsed.data as DashboardCommand); }
      catch (error) { this.post({ type: "operation.error", message: error instanceof Error ? error.message : "RuleSync could not complete that action." }); }
    }, undefined, this.#subscriptions);
  }

  private post(event: DashboardEvent): void { void this.#view?.webview.postMessage(event); }

  private badge(state: DashboardState): void {
    if (!this.#view) return;
    this.#view.badge = pendingBadge({ incoming: state.incomingCount, local: state.localCount, conflicts: state.conflictCount });
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
