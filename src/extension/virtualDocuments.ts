import * as vscode from "vscode";

export class VirtualDocumentStore implements vscode.TextDocumentContentProvider {
  readonly #documents = new Map<string, string>();
  readonly #emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.#emitter.event;

  set(scheme: "rulesync-remote" | "rulesync-base", folderUri: string, path: string, content: Uint8Array | undefined): vscode.Uri {
    const uri = vscode.Uri.parse(`${scheme}:/${encodeURIComponent(folderUri)}/${encodeURIComponent(path)}`);
    this.#documents.set(uri.toString(), content ? new TextDecoder().decode(content) : "");
    this.#emitter.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.#documents.get(uri.toString()) ?? "// RuleSync content is unavailable.\n";
  }

  dispose(): void {
    this.#documents.clear();
    this.#emitter.dispose();
  }
}
