import path from "node:path";
import * as vscode from "vscode";
import chokidar, { type FSWatcher } from "chokidar";
import { createCursorContent, classifyCursorPath, parseManifest, profileByName } from "@rulesync/adapters";
import { GitHubProvider, githubUserMessage, isUnauthorized, pollDeviceToken, refreshUserAccessToken, requestDeviceCode } from "@rulesync/provider-github";
import { acceptRisks, changeKey, defaultUpdateCheck, formatFileAuthorship, isUpdateCheckDue, managedRenamePath, planSync, remoteUpdateMessage, scanRisks, shouldKeepProposal, shouldRunUpdateCheck, unseenKeys, updateCheckIntervalMs, type AvailableRepository, type Change, type DashboardItem, type DashboardState, type FileEntry, type SourceSpec, type SyncPlan, type SyncState, type UpdateCheckSettings, type UpdateCheckTrigger } from "@rulesync/core";

import type { DashboardCommand } from "./protocol.js";
import { VirtualDocumentStore } from "./virtualDocuments.js";
import { hash, listFiles, removeFile, renameFile, workspacePath, writeFile } from "./filesystem.js";

const stateKey = "rulesync.syncState.v1";
const tokenKey = "rulesync.github.accessToken";
const refreshTokenKey = "rulesync.github.refreshToken";
const bundledGithubAppClientId = "Iv23li1SFwqQ6d45EmWN";
const githubAppInstallUrl = "https://github.com/apps/rulesync/installations/select_target";

type RemoteSnapshot = { commit: string; entries: FileEntry[] };

export class RuleSyncController implements vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<DashboardState>();
  readonly #virtualDocuments = new VirtualDocumentStore();
  #watcher: FSWatcher | undefined;
  #timer: NodeJS.Timeout | undefined;
  #refreshing = false;
  #remote: RemoteSnapshot | undefined;
  #local: FileEntry[] = [];
  #plan: SyncPlan | undefined;
  #status: DashboardState["status"] = "unconfigured";
  #statusMessage = "Connect a rules repository to begin.";
  #lastCheckedAt: string | undefined;
  #githubConnected = false;
  #manifestStatus: DashboardState["manifestStatus"] = "notChecked";
  #manifestMessage: string | undefined;
  #availableRepositories: AvailableRepository[] = [];
  #repositoriesStatus: DashboardState["repositoriesStatus"] = "idle";
  #repositoriesMessage: string | undefined;
  #repositoriesLoading = false;
  #reloadReposOnFocus = false;
  #offeredEmptyMain = false;
  #creatingEmptyMain = false;
  #authorship = new Map<string, { createdBy: string; lastEditedBy: string }>();
  #authorshipGeneration = 0;

  constructor(readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(this.#changed, this.#virtualDocuments);
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("rulesync-remote", this.#virtualDocuments));
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("rulesync-base", this.#virtualDocuments));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("rulesync.updateCheck")) {
        this.startPolling();
        this.publish();
        if (!event.affectsConfiguration("rulesync.sources") && !event.affectsConfiguration("rulesync.projectInitialized")) return;
      }
      if (event.affectsConfiguration("rulesync")) void this.initialize();
    }));
    context.subscriptions.push(vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        void this.maybeRefresh("focus");
        if (this.#reloadReposOnFocus && this.#githubConnected && !this.source()) {
          this.#reloadReposOnFocus = false;
          void this.loadAccessibleRepositories();
        }
      }
    }));
  }

  get onDidChange() { return this.#changed.event; }

  async initialize(): Promise<void> {
    this.#watcher?.close();
    this.#watcher = undefined;
    if (!this.workspaceRoot()) {
      this.#status = "error";
      this.#statusMessage = "RuleSync supports one folder workspace at a time.";
      this.publish();
      return;
    }
    try {
      await this.loadLocal();
    } catch (error) {
      this.#local = [];
      this.fail(error);
      return;
    }
    this.startWatching();
    this.startPolling();
    this.#lastCheckedAt = this.state().lastCheckedAt ?? this.#lastCheckedAt;
    this.#githubConnected = Boolean(await this.token());
    if (this.source()) {
      this.#status = "checking";
      this.#statusMessage = "Ready to check the configured source.";
      this.publish();
      if (await this.token()) await this.maybeRefresh("start"); else {
        this.#status = "needsReview";
        this.#statusMessage = "Sign in to GitHub to check remote rules.";
        this.rebuildPlan();
      }
    } else {
      this.#status = "unconfigured";
      this.#statusMessage = this.projectInitialized() ? "Connect a shared rules repository." : "Initialize RuleSync for this workspace.";
      this.#manifestStatus = "notChecked";
      this.#manifestMessage = undefined;
      this.rebuildPlan();
      if (this.#githubConnected) void this.loadAccessibleRepositories();
    }
  }

  dispose(): void {
    this.#watcher?.close();
    if (this.#timer) clearInterval(this.#timer);
  }

  async handle(command: DashboardCommand): Promise<void> {
    try {
      await this.dispatch(command);
    } catch (error) {
      if (isUnauthorized(error)) {
        const token = await this.refreshAccessToken();
        if (token) { await this.dispatch(command); return; }
        await this.forgetGithubSession();
        throw new Error("GitHub sign-in expired. Connect GitHub again.");
      }
      throw error instanceof Error ? new Error(githubUserMessage(error)) : error;
    }
  }

  private async dispatch(command: DashboardCommand): Promise<void> {
    switch (command.type) {
      case "ready": this.publish(); void this.maybeRefresh("dashboard"); return;
      case "auth.start": await this.authenticate(); return;
      case "github.app.create":
      case "github.app.install":
        this.#reloadReposOnFocus = true;
        await vscode.env.openExternal(vscode.Uri.parse(githubAppInstallUrl));
        return;
      case "github.app.help": await vscode.env.openExternal(vscode.Uri.parse("https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app")); return;
      case "workspace.initialize": await this.initializeWorkspace(); return;
      case "manifest.initialize": await this.initializeManifest(); return;
      case "github.clientId.save": await this.saveClientId(command.clientId); return;
      case "source.save": await this.saveSource(command.source); return;
      case "github.repos.refresh": await this.loadAccessibleRepositories(); return;
      case "sync.refresh": await this.maybeRefresh("manual"); return;
      case "settings.updateCheck": await this.saveUpdateCheck(command.settings); return;
      case "content.open": await this.open(command.path); return;
      case "content.diff": await this.diff(command.path, command.comparison); return;
      case "content.create": await this.create(command.request); return;
      case "content.rename": await this.rename(command.path); return;
      case "content.delete": await this.delete(command.path); return;
      case "content.revert": await this.revert(command.path); return;
      case "conflict.resolve": await this.resolve(command.path, command.resolution); return;
      case "remote.apply": await this.applyOne(command.path); return;
      case "remote.applyAll": await this.applyAll(); return;
      case "risks.accept": await this.acceptVisibleRisks(); return;
      case "proposal.publish": await this.publishProposal(command.message); return;
      case "proposal.openCompare": await this.openCompare(); return;
      case "settings.open": await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:rulesync.rulesync"); return;
      case "source.disconnect": await this.disconnect(); return;
    }
  }

  dashboardState(): DashboardState {
    const source = this.source();
    const state = this.state();
    const changes = this.#plan?.changes ?? [];
    const changed = new Map(changes.map((change) => [change.path, change]));
    const paths = new Set([...this.#local.map((entry) => entry.path), ...this.#remote?.entries.map((entry) => entry.path) ?? []]);
    const items: DashboardItem[] = [...paths].sort().map((itemPath) => {
      const change = changed.get(itemPath);
      const remote = this.#remote?.entries.find((entry) => entry.path === itemPath);
      const authorship = remote ? this.#authorship.get(`${itemPath}@${remote.contentHash}`) : undefined;
      const folder = path.dirname(itemPath);
      return {
        path: itemPath,
        name: path.basename(itemPath),
        type: classifyCursorPath(itemPath),
        status: change?.status ?? "synced",
        kind: change?.kind,
        detail: [folder === "." ? undefined : folder, formatFileAuthorship(authorship ?? {})].filter(Boolean).join(" · "),
        createdBy: authorship?.createdBy,
        lastEditedBy: authorship?.lastEditedBy
      };
    });
    return {
      configured: Boolean(source),
      projectInitialized: this.projectInitialized(),
      workspaceName: this.workspaceRoot() ? path.basename(this.workspaceRoot()!) : undefined,
      hasLocalCursorConfiguration: this.#local.length > 0,
      githubConnected: this.#githubConnected,
      manifestStatus: this.#manifestStatus,
      manifestMessage: this.#manifestMessage,
      trusted: vscode.workspace.isTrusted,
      source,
      repositoryUrl: source ? `https://github.com/${source.repository}` : undefined,
      branch: source?.ref,
      profile: source?.profile,
      status: this.#status,
      statusMessage: this.#statusMessage,
      lastCheckedAt: this.#lastCheckedAt,
      updateCheck: this.updateCheck(),
      items,
      incomingCount: this.#plan?.incoming.length ?? 0,
      localCount: this.#plan?.local.length ?? 0,
      conflictCount: this.#plan?.conflicts.length ?? 0,
      warningCount: this.#plan?.risks.length ?? 0,
      proposedCount: state.activeProposal ? this.#plan?.local.length ?? 0 : 0,
      risks: this.#plan?.risks ?? [],
      activeProposal: state.activeProposal,
      availableRepositories: this.#availableRepositories,
      repositoriesStatus: this.#repositoriesStatus,
      repositoriesMessage: this.#repositoriesMessage
    };
  }

  private workspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders?.length === 1 && folders[0]?.uri.scheme === "file" ? folders[0].uri.fsPath : undefined;
  }

  private source(): SourceSpec | undefined {
    const configured = vscode.workspace.getConfiguration("rulesync").get<SourceSpec[]>("sources", []);
    return configured.find((source) => source.enabled !== false);
  }

  private projectInitialized(): boolean {
    return vscode.workspace.getConfiguration("rulesync").get<boolean>("projectInitialized", false);
  }

  private optOut(): string[] {
    const source = this.source();
    if (!source) return [];
    const all = vscode.workspace.getConfiguration("rulesync").get<Array<{ source: string; paths: string[] }>>("optOut", []);
    return all.find((entry) => entry.source === source.id)?.paths ?? [];
  }

  private state(): SyncState {
    const stored = this.context.workspaceState.get<SyncState>(stateKey);
    return stored && stored.sourceIdentity === this.sourceIdentity() ? stored : { schemaVersion: 1, sourceIdentity: this.sourceIdentity(), entries: {} };
  }

  private sourceIdentity(): string {
    const source = this.source();
    return source ? `${source.provider}:${source.repository}:${source.ref ?? "default"}:${source.profile}` : "unconfigured";
  }

  private async saveState(next: SyncState): Promise<void> { await this.context.workspaceState.update(stateKey, next); }

  private async token(): Promise<string | undefined> { return this.context.secrets.get(tokenKey); }

  private async forgetGithubSession(): Promise<void> {
    await this.context.secrets.delete(tokenKey);
    await this.context.secrets.delete(refreshTokenKey);
    this.#githubConnected = false;
  }

  private async refreshAccessToken(): Promise<string | undefined> {
    const refreshToken = await this.context.secrets.get(refreshTokenKey);
    if (!refreshToken) return undefined;
    try {
      const token = await refreshUserAccessToken(this.clientId(), refreshToken);
      await this.context.secrets.store(tokenKey, token.accessToken);
      if (token.refreshToken) await this.context.secrets.store(refreshTokenKey, token.refreshToken);
      this.#githubConnected = true;
      return token.accessToken;
    } catch { return undefined; }
  }

  private async withGithub<T>(run: (github: GitHubProvider) => Promise<T>): Promise<T> {
    const token = await this.token();
    if (!token) throw new Error("Sign in to GitHub to continue.");
    try { return await run(new GitHubProvider(token)); } catch (error) {
      if (!isUnauthorized(error)) throw error;
      const next = await this.refreshAccessToken();
      if (!next) {
        await this.forgetGithubSession();
        throw new Error("GitHub sign-in expired. Connect GitHub again.");
      }
      return run(new GitHubProvider(next));
    }
  }

  private clientId(): string {
    return vscode.workspace.getConfiguration("rulesync").get<string>("githubAppClientId", "")?.trim() || bundledGithubAppClientId;
  }

  private async loadAccessibleRepositories(): Promise<void> {
    const token = await this.token();
    if (!token || this.#repositoriesLoading) return;
    this.#repositoriesLoading = true;
    this.#repositoriesStatus = "loading";
    this.#repositoriesMessage = undefined;
    this.publish();
    try {
      this.#availableRepositories = await this.withGithub((github) => github.listAccessibleRepositories());
      this.#repositoriesStatus = "ready";
    } catch (error) {
      this.#availableRepositories = [];
      this.#repositoriesStatus = "error";
      this.#repositoriesMessage = error instanceof Error ? error.message : "Could not load repositories from GitHub.";
    } finally {
      this.#repositoriesLoading = false;
      this.publish();
    }
  }

  private assertTrusted(): void {
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before RuleSync reads or writes local files.");
  }

  private async loadLocal(): Promise<void> {
    const root = this.workspaceRoot();
    this.#local = root ? await listFiles(root) : [];
  }

  private startWatching(): void {
    const root = this.workspaceRoot();
    if (!root) return;
    this.#watcher = chokidar.watch(path.join(root, ".cursor"), { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 750, pollInterval: 100 } });
    this.#watcher.on("all", () => void this.onLocalChange());
  }

  private startPolling(): void {
    if (this.#timer) clearInterval(this.#timer);
    const settings = this.updateCheck();
    if (settings.mode !== "timed" && settings.mode !== "both") return;
    this.#timer = setInterval(() => void this.maybeRefresh("timer"), 60_000);
  }

  private updateCheck(): UpdateCheckSettings {
    const cfg = vscode.workspace.getConfiguration("rulesync");
    const mode = cfg.get<UpdateCheckSettings["mode"]>("updateCheck.mode");
    if (mode === "off" || mode === "timed" || mode === "events" || mode === "both") {
      return {
        mode,
        interval: (["hourly", "daily", "weekly"] as const).find((value) => value === cfg.get("updateCheck.interval")) ?? defaultUpdateCheck.interval,
        onStart: cfg.get<boolean>("updateCheck.onStart", defaultUpdateCheck.onStart),
        onFocus: cfg.get<boolean>("updateCheck.onFocus", defaultUpdateCheck.onFocus),
        onDashboardOpen: cfg.get<boolean>("updateCheck.onDashboardOpen", defaultUpdateCheck.onDashboardOpen)
      };
    }
    const inspected = cfg.inspect<number>("checkIntervalMinutes");
    const legacy = inspected?.workspaceValue ?? inspected?.globalValue;
    if (typeof legacy === "number") {
      return { ...defaultUpdateCheck, mode: "timed", interval: legacy <= 90 ? "hourly" : "daily" };
    }
    return { ...defaultUpdateCheck };
  }

  private async saveUpdateCheck(settings: UpdateCheckSettings): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("rulesync");
    const target = vscode.ConfigurationTarget.Global;
    await cfg.update("updateCheck.mode", settings.mode, target);
    await cfg.update("updateCheck.interval", settings.interval, target);
    await cfg.update("updateCheck.onStart", settings.onStart, target);
    await cfg.update("updateCheck.onFocus", settings.onFocus, target);
    await cfg.update("updateCheck.onDashboardOpen", settings.onDashboardOpen, target);
  }

  private async notifyRemoteUpdates(state: SyncState): Promise<void> {
    const plan = this.#plan;
    if (!plan) return;
    const incomingKeys = plan.incoming.map((change) => changeKey(change.path, change.remote?.contentHash));
    const conflictKeys = plan.conflicts.map((change) => changeKey(change.path, change.remote?.contentHash));
    const keys = [...incomingKeys, ...conflictKeys];
    const fresh = unseenKeys(state.notifiedIncoming, keys);
    state.notifiedIncoming = keys;
    await this.saveState(state);
    if (!fresh.length) return;
    const incoming = incomingKeys.filter((key) => fresh.includes(key)).length;
    const conflicts = conflictKeys.filter((key) => fresh.includes(key)).length;
    const message = remoteUpdateMessage(incoming, conflicts);
    if (!message) return;
    const answer = await vscode.window.showInformationMessage(message, "Review");
    if (answer === "Review") await vscode.commands.executeCommand("rulesync.openDashboard");
  }

  private async maybeRefresh(trigger: UpdateCheckTrigger): Promise<void> {
    const settings = this.updateCheck();
    if (!shouldRunUpdateCheck(settings, trigger)) return;
    if (trigger === "timer" && !isUpdateCheckDue(this.#lastCheckedAt, updateCheckIntervalMs(settings.interval))) return;
    if ((trigger === "focus" || trigger === "dashboard") && !isUpdateCheckDue(this.#lastCheckedAt, 2 * 60_000)) return;
    await this.refresh();
  }

  private async onLocalChange(): Promise<void> {
    try {
      await this.loadLocal();
      this.rebuildPlan();
      if (this.source()) {
        this.#status = this.#plan && (this.#plan.local.length || this.#plan.conflicts.length) ? "needsReview" : "synced";
        this.#statusMessage = this.#plan?.local.length ? "Local changes are ready for review." : this.#statusMessage;
      }
      this.publish();
    } catch (error) { this.fail(error); }
  }

  private rebuildPlan(): void {
    const remote = this.#remote?.entries ?? [];
    this.#plan = planSync({ baseline: this.state().entries, local: this.#local, remote, optOut: this.optOut(), classify: classifyCursorPath, risks: scanRisks([...this.#local, ...remote]), acceptedRisks: this.state().acceptedRisks });
  }

  private contentHashes(): Map<string, string> {
    const hashes = new Map<string, string>();
    for (const entry of this.#remote?.entries ?? []) hashes.set(entry.path, entry.contentHash);
    for (const entry of this.#local) hashes.set(entry.path, entry.contentHash);
    return hashes;
  }

  private async acceptVisibleRisks(): Promise<void> {
    if (!this.#plan?.risks.length) return;
    const state = this.state();
    state.acceptedRisks = acceptRisks(state.acceptedRisks, this.#plan.risks, this.contentHashes());
    await this.saveState(state);
    this.rebuildPlan();
    this.publish();
  }

  private async loadAuthorship(): Promise<void> {
    const generation = ++this.#authorshipGeneration;
    const source = this.source();
    const remote = this.#remote;
    if (!source || !remote) return;
    const missing = remote.entries.filter((entry) => !this.#authorship.has(`${entry.path}@${entry.contentHash}`));
    if (!missing.length) return;
    try {
      await this.withGithub(async (provider) => {
        for (let index = 0; index < missing.length; index += 5) {
          if (generation !== this.#authorshipGeneration) return;
          await Promise.all(missing.slice(index, index + 5).map(async (entry) => {
            try {
              const info = await provider.getFileAuthorship(source.repository, entry.path, remote.commit);
              if (info) this.#authorship.set(`${entry.path}@${entry.contentHash}`, info);
            } catch { /* leave the row without git authors */ }
          }));
          if (generation === this.#authorshipGeneration) this.publish();
        }
      });
    } catch { /* authorship is additive */ }
  }

  private publish(): void { this.#changed.fire(this.dashboardState()); }

  private fail(error: unknown): void {
    if (isUnauthorized(error)) {
      void this.forgetGithubSession();
      this.#githubConnected = false;
      this.#status = "needsReview";
      this.#statusMessage = "GitHub sign-in expired. Connect GitHub again.";
      this.publish();
      return;
    }
    this.#status = "error";
    this.#statusMessage = githubUserMessage(error);
    this.publish();
  }

  private async authenticate(): Promise<void> {
    const clientId = this.clientId();
    try {
      const device = await requestDeviceCode(clientId);
      await vscode.env.openExternal(vscode.Uri.parse(device.verificationUri));
      void vscode.window.showInformationMessage(`Enter GitHub code ${device.userCode} to connect RuleSync.`);
      this.#status = "checking";
      this.#statusMessage = `Waiting for GitHub authorization: ${device.userCode}`;
      this.publish();
      const deadline = Date.now() + device.expiresIn * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, device.interval * 1000));
        const token = await pollDeviceToken(clientId, device.deviceCode);
        if (!token) continue;
        await this.context.secrets.store(tokenKey, token.accessToken);
        if (token.refreshToken) await this.context.secrets.store(refreshTokenKey, token.refreshToken);
        this.#githubConnected = true;
        this.#status = "needsReview";
        this.#statusMessage = "GitHub connected. Choose a rules repository.";
        await this.loadAccessibleRepositories();
        await this.refresh();
        return;
      }
      throw new Error("GitHub authorization timed out.");
    } catch (error) { this.fail(error); }
  }

  private async saveClientId(clientId: string): Promise<void> {
    await vscode.workspace.getConfiguration("rulesync").update("githubAppClientId", clientId.trim(), vscode.ConfigurationTarget.Workspace);
    await this.authenticate();
  }

  private async initializeWorkspace(): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) throw new Error("Open a single project folder before initializing RuleSync.");
    await vscode.workspace.getConfiguration("rulesync").update("projectInitialized", true, vscode.ConfigurationTarget.Workspace);
    this.#status = "unconfigured";
    this.#statusMessage = this.#local.length ? "This workspace has Cursor configuration ready to share." : "Workspace initialized. Connect a shared rules repository next.";
    this.publish();
  }

  private async saveSource(source: SourceSpec): Promise<void> {
    if (source.provider !== "github" || !source.repository || !source.profile) throw new Error("Repository and profile are required.");
    await vscode.workspace.getConfiguration("rulesync").update("projectInitialized", true, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration("rulesync").update("sources", [{ ...source, enabled: true }], vscode.ConfigurationTarget.Workspace);
    await this.saveState({ schemaVersion: 1, sourceIdentity: this.sourceIdentity(), entries: {} });
    await this.initialize();
  }

  async refresh(): Promise<void> {
    if (this.#refreshing || !this.source()) return;
    const token = await this.token();
    if (!token) { this.#status = "needsReview"; this.#statusMessage = "Sign in to GitHub to check remote rules."; this.publish(); return; }
    this.#refreshing = true;
    this.#status = "checking";
    this.#statusMessage = "Checking remote rules…";
    this.publish();
    try {
      const source = this.source()!;
      await this.withGithub(async (provider) => {
      let repository: { defaultBranch: string; fullName: string };
      try {
        repository = await provider.verifyRepository(source.repository);
      } catch (error) {
        if (this.isNotFound(error) || this.isForbidden(error)) {
          throw new Error("RuleSync cannot access this repository. Install the RuleSync GitHub App on it, then check again.");
        }
        throw error;
      }
      const branch = source.ref || repository.defaultBranch;
      let commit: string;
      try {
        commit = await provider.getRef(source.repository, branch);
      } catch (error) {
        if ((this.isNotFound(error) || this.isConflict(error)) && await provider.isEmptyRepository(source.repository)) {
          this.#remote = undefined;
          this.#manifestStatus = "empty";
          this.#manifestMessage = `${source.repository} has no ${branch} branch.`;
          this.rebuildPlan();
          this.#lastCheckedAt = new Date().toISOString();
          this.#status = "needsReview";
          this.#statusMessage = `${source.repository} has no ${branch} branch. RuleSync can create it for you.`;
          this.publish();
          return;
        }
        throw error;
      }
      let manifestText: string;
      try {
        manifestText = new TextDecoder().decode(await provider.getFileAtRef(source.repository, commit, "rulesync.yml"));
      } catch (error: unknown) {
        if (this.isNotFound(error)) {
          this.#remote = { commit, entries: [] };
          this.#manifestStatus = "missing";
          this.#manifestMessage = "This repository has no rulesync.yml yet.";
          this.rebuildPlan();
          this.#lastCheckedAt = new Date().toISOString();
          this.#status = "needsReview";
          this.#statusMessage = "Initialize this repository with a RuleSync manifest.";
          this.publish();
          return;
        }
        throw error;
      }
      this.#manifestStatus = "ready";
      this.#manifestMessage = undefined;
      const profile = profileByName(parseManifest(manifestText), source.profile);
      if (profile.adapter !== "cursor") throw new Error("The MVP dashboard currently supports Cursor project profiles only.");
      const prefix = `${profile.source.replace(/\/$/, "")}/`;
      const tree = await provider.getTree(source.repository, commit);
      const candidates = tree.filter((entry) => entry.path.startsWith(prefix));
      const entries = await Promise.all(candidates.map(async (entry) => {
        const content = await provider.getBlob(source.repository, entry.oid);
        return { path: entry.path, content, contentHash: hash(content), size: content.byteLength, mode: entry.mode } satisfies FileEntry;
      }));
      this.#remote = { commit, entries };
      const state = this.state();
      for (const local of this.#local) {
        const remote = entries.find((entry) => entry.path === local.path);
        if (remote && remote.contentHash === local.contentHash && !state.entries[local.path]) {
          state.entries[local.path] = { remoteOid: remote.contentHash, localHash: local.contentHash, mode: local.mode };
        }
      }
      await this.saveState(state);
      this.rebuildPlan();
      if (state.activeProposal) {
        const pullRequest = await provider.findPullRequest(source.repository, state.activeProposal.branch);
        if (pullRequest) state.activeProposal.pullRequest = pullRequest;
        else if (!shouldKeepProposal(false, this.#plan?.local.length ?? 0)) delete state.activeProposal;
        await this.saveState(state);
      }
      this.#lastCheckedAt = new Date().toISOString();
      state.lastCheckedAt = this.#lastCheckedAt;
      await this.saveState(state);
      const plan = this.#plan;
      this.#status = plan && (plan.conflicts.length || plan.incoming.length || plan.local.length) ? "needsReview" : "synced";
      this.#statusMessage = this.#status === "synced" ? "Everything is synchronized." : "Changes are ready for review.";
      this.publish();
      void this.notifyRemoteUpdates(state);
      void this.loadAuthorship();
      });
    } catch (error) {
      this.#manifestStatus = this.#manifestStatus === "ready" ? "invalid" : this.#manifestStatus;
      if (this.#manifestStatus === "invalid") this.#manifestMessage = "The remote rulesync.yml could not be validated.";
      this.fail(error);
    }
    finally { this.#refreshing = false; }
    if (this.#manifestStatus === "empty" && !this.#offeredEmptyMain) {
      this.#offeredEmptyMain = true;
      void this.createEmptyMain();
    }
  }

  private async open(itemPath: string): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) return;
    const local = this.#local.find((entry) => entry.path === itemPath);
    if (local) await vscode.window.showTextDocument(vscode.Uri.file(workspacePath(root, itemPath)), { preview: true });
    else {
      const remote = this.#remote?.entries.find((entry) => entry.path === itemPath);
      if (remote) await vscode.window.showTextDocument(this.#virtualDocuments.set("rulesync-remote", itemPath, remote.content), { preview: true });
    }
  }

  private async diff(itemPath: string, comparison: "remote" | "base"): Promise<void> {
    const root = this.workspaceRoot();
    const remote = this.#remote?.entries.find((entry) => entry.path === itemPath);
    const local = this.#local.find((entry) => entry.path === itemPath);
    if (!root || !remote && !local) return;
    const incoming = comparison === "remote" && this.#plan?.changes.find((change) => change.path === itemPath)?.status === "incoming";
    const remoteUri = this.#virtualDocuments.set("rulesync-remote", itemPath, remote?.content);
    const localUri = local ? vscode.Uri.file(workspacePath(root, itemPath)) : this.#virtualDocuments.set("rulesync-base", itemPath, undefined);
    if (incoming) {
      await vscode.commands.executeCommand("vscode.diff", localUri, remoteUri, `Local → Remote: ${path.basename(itemPath)}`);
      return;
    }
    const left = comparison === "remote" ? remoteUri : this.#virtualDocuments.set("rulesync-base", itemPath, remote?.content);
    await vscode.commands.executeCommand("vscode.diff", left, localUri, `${comparison === "remote" ? "Remote" : "Baseline"} ↔ Local: ${path.basename(itemPath)}`);
  }

  private async create(request: Extract<DashboardCommand, { type: "content.create" }> ["request"]): Promise<void> {
    this.assertTrusted();
    const root = this.workspaceRoot();
    if (!root) return;
    const content = createCursorContent(request);
    await writeFile(root, { path: content.path, content: new TextEncoder().encode(content.contents), contentHash: "", size: content.contents.length, mode: content.mode });
    await this.onLocalChange();
    await this.open(content.path);
  }

  private async rename(previous: string): Promise<void> {
    this.assertTrusted();
    const root = this.workspaceRoot();
    if (!root) return;
    if (!this.#local.some((entry) => entry.path === previous)) throw new Error("Pull this file before renaming it.");
    const typed = await vscode.window.showInputBox({ title: "Rename managed file", prompt: "New path under .cursor", value: previous, ignoreFocusOut: true, validateInput: (value) => { try { managedRenamePath(previous, value); return; } catch (error) { return error instanceof Error ? error.message : "Invalid path"; } } });
    if (!typed) return;
    const next = managedRenamePath(previous, typed);
    if (this.#local.some((entry) => entry.path === next)) throw new Error("A managed file already exists at that path.");
    await renameFile(root, previous, next);
    await this.onLocalChange();
  }

  private async delete(itemPath: string): Promise<void> {
    this.assertTrusted();
    const root = this.workspaceRoot();
    if (!root) return;
    const answer = await vscode.window.showWarningMessage(`Delete ${path.basename(itemPath)} locally? This will become a proposal change.`, { modal: true }, "Delete");
    if (answer !== "Delete") return;
    await removeFile(root, itemPath);
    await this.onLocalChange();
  }

  private async revert(itemPath: string): Promise<void> {
    this.assertTrusted();
    const root = this.workspaceRoot();
    const local = this.#local.find((entry) => entry.path === itemPath);
    const remote = this.#remote?.entries.find((entry) => entry.path === itemPath);
    if (!root || !local) throw new Error("This file is not in the workspace.");
    const name = path.basename(itemPath);
    if (remote) {
      const answer = await vscode.window.showWarningMessage(`Revert ${name} to the remote version? Local edits will be lost.`, { modal: true }, "Revert");
      if (answer !== "Revert") return;
      await writeFile(root, remote);
    } else {
      const answer = await vscode.window.showWarningMessage(`Discard ${name}? This new local file will be deleted.`, { modal: true }, "Discard");
      if (answer !== "Discard") return;
      await removeFile(root, itemPath);
    }
    await this.onLocalChange();
  }

  private async resolve(itemPath: string, resolution: "local" | "remote"): Promise<void> {
    const root = this.workspaceRoot();
    const remote = this.#remote?.entries.find((entry) => entry.path === itemPath);
    if (!root || !remote) throw new Error("Remote content is unavailable for this conflict.");
    if (resolution === "remote") {
      this.assertTrusted();
      await writeFile(root, remote);
      await this.onLocalChange();
      return;
    }
    const state = this.state();
    state.entries[itemPath] = { remoteOid: remote.contentHash, localHash: remote.contentHash, mode: remote.mode };
    await this.saveState(state);
    this.rebuildPlan();
    this.publish();
  }

  private async applyOne(itemPath: string): Promise<void> {
    if (!await this.writeIncoming([itemPath])) return;
    this.#status = this.#plan?.incoming.length || this.#plan?.local.length || this.#plan?.conflicts.length ? "needsReview" : "synced";
    this.#statusMessage = `Pulled ${path.basename(itemPath)}.`;
    this.publish();
  }

  private async applyAll(): Promise<void> {
    if (!this.#plan || !this.#remote) throw new Error("Check remote rules before applying updates.");
    if (this.#plan.conflicts.length) throw new Error("Resolve every conflict before applying remote updates.");
    if (!this.#plan.incoming.length) return;
    if (!await this.writeIncoming(this.#plan.incoming.map((change) => change.path))) return;
    const state = this.state();
    for (const remote of this.#remote.entries) {
      const local = this.#local.find((entry) => entry.path === remote.path);
      if (local?.contentHash === remote.contentHash) state.entries[remote.path] = { remoteOid: remote.contentHash, localHash: remote.contentHash, mode: remote.mode };
    }
    for (const trackedPath of Object.keys(state.entries)) {
      if (!this.#remote.entries.some((entry) => entry.path === trackedPath) && !this.#local.some((entry) => entry.path === trackedPath)) delete state.entries[trackedPath];
    }
    state.baselineCommit = this.#remote.commit;
    await this.saveState(state);
    this.rebuildPlan();
    this.#status = this.#plan.local.length ? "needsReview" : "synced";
    this.#statusMessage = "Remote updates applied.";
    this.publish();
  }

  private async writeIncoming(paths: readonly string[]): Promise<boolean> {
    this.assertTrusted();
    if (!this.#plan || !this.#remote) throw new Error("Check remote rules before applying updates.");
    const incoming = new Set(this.#plan.incoming.map((change) => change.path));
    for (const itemPath of paths) {
      if (!incoming.has(itemPath)) throw new Error(`${path.basename(itemPath)} is not waiting to be pulled.`);
    }
    const risky = this.#plan.risks.filter((risk) => paths.includes(risk.path));
    if (risky.length) {
      const single = paths.length === 1;
      const answer = await vscode.window.showWarningMessage(single ? `Pull ${path.basename(paths[0]!)}? It includes ${risky.length} security warning(s).` : `Apply ${paths.length} remote changes, including ${risky.length} security warning(s)?`, { modal: true }, single ? "Pull" : "Apply Changes");
      if (answer !== "Pull" && answer !== "Apply Changes") return false;
      const state = this.state();
      state.acceptedRisks = acceptRisks(state.acceptedRisks, risky, this.contentHashes());
      await this.saveState(state);
    }
    const root = this.workspaceRoot();
    if (!root) return false;
    for (const itemPath of paths) {
      const remote = this.#remote.entries.find((entry) => entry.path === itemPath);
      if (remote) await writeFile(root, remote);
      else await removeFile(root, itemPath);
    }
    await this.loadLocal();
    const state = this.state();
    for (const itemPath of paths) {
      const remote = this.#remote.entries.find((entry) => entry.path === itemPath);
      const local = this.#local.find((entry) => entry.path === itemPath);
      if (remote && local?.contentHash === remote.contentHash) state.entries[itemPath] = { remoteOid: remote.contentHash, localHash: remote.contentHash, mode: remote.mode };
      else if (!remote && !local) delete state.entries[itemPath];
    }
    await this.saveState(state);
    this.rebuildPlan();
    return true;
  }

  private async publishProposal(message: string): Promise<void> {
    this.assertTrusted();
    const source = this.source();
    const token = await this.token();
    if (!source || !token || !this.#plan) throw new Error("Connect and refresh a rules source before publishing.");
    if (this.#manifestStatus === "empty" || !this.#remote) {
      await this.createEmptyMain();
      return;
    }
    if (this.#manifestStatus !== "ready") throw new Error("Create and merge rulesync.yml before publishing managed configuration.");
    if (this.#plan.incoming.length || this.#plan.conflicts.length) throw new Error("Review remote updates and conflicts before publishing local changes.");
    if (!this.#plan.local.length) throw new Error("There are no local changes to publish.");
    const risky = this.#plan.risks.filter((risk) => this.#plan!.local.some((change) => change.path === risk.path));
    if (risky.length) {
      const answer = await vscode.window.showWarningMessage(`Publish ${this.#plan.local.length} local changes, including ${risky.length} security warning(s)?`, { modal: true }, "Publish Branch");
      if (answer !== "Publish Branch") return;
      const state = this.state();
      state.acceptedRisks = acceptRisks(state.acceptedRisks, risky, this.contentHashes());
      await this.saveState(state);
    }
    await this.withGithub(async (provider) => {
      const verified = await provider.verifyRepository(source.repository);
      const baseBranch = source.ref || verified.defaultBranch;
      const latest = await provider.getRef(source.repository, baseBranch);
      if (latest !== this.#remote!.commit) throw new Error("The remote branch changed. Refresh and review before publishing.");
      const state = this.state();
      const existing = state.activeProposal;
      if (existing) {
        const actualHead = await provider.getRef(source.repository, existing.branch);
        if (actualHead !== existing.headCommit) throw new Error("The proposal branch changed outside RuleSync. Refresh it on GitHub before updating.");
      }
      const branch = existing?.branch ?? `rulesync/${this.githubSafeName(await provider.authenticatedLogin())}/${this.branchTimestamp()}`;
      const proposal = await provider.createProposal({ repository: source.repository, baseBranch, baseCommit: this.#remote!.commit, branch, parentCommit: existing?.headCommit, updateExisting: Boolean(existing), message: message.trim() || "chore(rules): propose RuleSync updates", changes: this.#plan!.local.map((change) => ({ path: change.path, entry: this.#local.find((entry) => entry.path === change.path) })) });
      state.activeProposal = proposal;
      await this.saveState(state);
      this.#status = "needsReview";
      this.#statusMessage = "Proposal branch is ready. Create the pull request on GitHub.";
      this.publish();
    });
  }

  private githubSafeName(login: string): string { return login.toLowerCase().replace(/[^a-z0-9-]/g, "-") || "user"; }
  private branchTimestamp(): string { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, ""); }

  private async openCompare(): Promise<void> {
    const proposal = this.state().activeProposal;
    if (!proposal) throw new Error("Publish a proposal branch first.");
    await vscode.env.clipboard.writeText("chore(rules): propose RuleSync updates");
    await vscode.env.openExternal(vscode.Uri.parse(proposal.pullRequest?.url ?? proposal.compareUrl));
  }

  private async initializeManifest(): Promise<void> {
    if (this.#manifestStatus === "empty") {
      await this.createEmptyMain();
      return;
    }
    const source = this.source();
    const token = await this.token();
    if (!source || !token || !this.#remote || this.#manifestStatus !== "missing") throw new Error("Connect a repository without rulesync.yml before initializing it.");
    const answer = await vscode.window.showInformationMessage("Create a RuleSync starter manifest on a new proposal branch, then open the pull request?", { modal: true }, "Create Branch");
    if (answer !== "Create Branch") return;
    await this.withGithub(async (provider) => {
      const repository = await provider.verifyRepository(source.repository);
      const baseBranch = source.ref || repository.defaultBranch;
      const branch = `rulesync/${this.githubSafeName(await provider.authenticatedLogin())}/initialize-${this.branchTimestamp()}`;
      const contents = new TextEncoder().encode("version: 1\n\nprofiles:\n  cursor-project:\n    adapter: cursor\n    scope: project\n    source: .cursor\n    mode: mirror\n");
      const proposal = await provider.createProposal({
        repository: source.repository,
        baseBranch,
        baseCommit: this.#remote!.commit,
        branch,
        message: "chore(rules): initialize RuleSync manifest",
        changes: [{ path: "rulesync.yml", entry: { path: "rulesync.yml", content: contents, contentHash: hash(contents), size: contents.byteLength, mode: "file" } }]
      });
      const state = this.state();
      state.activeProposal = proposal;
      try {
        state.activeProposal.pullRequest = await provider.createPullRequest(source.repository, {
          title: "chore(rules): initialize RuleSync manifest",
          head: proposal.branch,
          base: baseBranch,
          body: "Adds the starter rulesync.yml so this repository can sync Cursor configuration."
        });
      } catch { /* compare URL remains if the app cannot open pull requests */ }
      await this.saveState(state);
      this.#manifestStatus = "pending";
      this.#manifestMessage = state.activeProposal.pullRequest
        ? `Pull request #${state.activeProposal.pullRequest.number} is ready. Merge it on GitHub, then check again.`
        : "Starter manifest is on a proposal branch. Create and merge the pull request on GitHub.";
      this.#status = "needsReview";
      this.#statusMessage = state.activeProposal.pullRequest ? "Manifest pull request is ready to merge." : "Manifest proposal branch is ready.";
      this.publish();
    });
  }

  private async createEmptyMain(): Promise<void> {
    if (this.#creatingEmptyMain) return;
    this.#creatingEmptyMain = true;
    try { await this.createEmptyMainOnce(); } finally { this.#creatingEmptyMain = false; }
  }

  private async createEmptyMainOnce(): Promise<void> {
    const source = this.source();
    const token = await this.token();
    if (!source || !token || this.#manifestStatus !== "empty") throw new Error("This repository already has a base branch.");
    const branch = source.ref || "main";
    const answer = await vscode.window.showInformationMessage(
      `${source.repository} has no ${branch} branch. Create it for you so RuleSync can open pull requests?`,
      { modal: true },
      "Create it for me"
    );
    if (answer !== "Create it for me") return;
    await this.withGithub(async (provider) => {
      const repository = await provider.verifyRepository(source.repository);
      const baseBranch = source.ref || repository.defaultBranch || "main";
      if (!await provider.isEmptyRepository(source.repository)) {
        await this.refresh();
        return;
      }
      const commit = await provider.createEmptyBranch(source.repository, baseBranch);
      this.#remote = { commit, entries: [] };
      this.#manifestStatus = "missing";
      this.#manifestMessage = `${baseBranch} is ready. Initialize rulesync.yml next.`;
      this.#status = "needsReview";
      this.#statusMessage = `${baseBranch} exists. Create the rulesync.yml pull request next.`;
      this.rebuildPlan();
      this.publish();
    });
    await this.refresh();
  }

  private isNotFound(error: unknown): boolean {
    return typeof error === "object" && error !== null && "status" in error && (error as { status?: unknown }).status === 404;
  }

  private isConflict(error: unknown): boolean {
    return typeof error === "object" && error !== null && "status" in error && (error as { status?: unknown }).status === 409;
  }

  private isForbidden(error: unknown): boolean {
    return typeof error === "object" && error !== null && "status" in error && (error as { status?: unknown }).status === 403;
  }

  private async disconnect(): Promise<void> {
    await vscode.workspace.getConfiguration("rulesync").update("sources", [], vscode.ConfigurationTarget.Workspace);
    await this.context.workspaceState.update(stateKey, undefined);
    this.#remote = undefined;
    this.#manifestStatus = "notChecked";
    this.#manifestMessage = undefined;
    this.#offeredEmptyMain = false;
    this.#availableRepositories = [];
    this.#repositoriesStatus = "idle";
    this.#repositoriesMessage = undefined;
    await this.initialize();
  }
}
