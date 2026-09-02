import path from "node:path";
import * as vscode from "vscode";
import chokidar, { type FSWatcher } from "chokidar";
import { createCursorContent, classifyCursorPath, cursorLocalRoot } from "@rulesync/adapters";
import { acceptRisks, assertManagedCursorPath, authorshipCap, blobConcurrency, canDisableManagedPath, canonicalGitlabBaseUrl, changeKey, configuredSource, disabledDiskPath, diskManagedPath, foldLocalDisabled, formatFileAuthorship, isConflict, isForbidden, isHighRisk, isNotFound, isTimeoutAbort, isUnauthorized, isUpdateCheckDue, limitError, managedFileCap, managedRenamePath, mapLimited, maxAggregateBytes, maxFileBytes, planSync, proposalCommitMessage, providerUserMessage, remoteUpdateMessage, scanRisks, shouldKeepProposal, shouldRunUpdateCheck, sourceIdentity, unseenKeys, updateCheckIntervalMs, type AvailableRepository, type DashboardFolder, type DashboardItem, type DashboardState, type FileEntry, type LegacyWorkspaceSource, type ProviderId, type RiskFinding, type RulesProvider, type SourceSpec, type SyncPlan, type SyncState, type UpdateCheckSettings, type UpdateCheckTrigger } from "@rulesync/core";

import type { DashboardCommand } from "./protocol.js";
import { VirtualDocumentStore } from "./virtualDocuments.js";
import { assertSafeManagedPath, hash, listFiles, removeFile, renameFile, workspacePath, writeFile } from "./filesystem.js";
import { excludeLocalOnly, isLocalOnlyPath, parseLocalOnlyRegistry, serializeLocalOnlyRegistry } from "./localOnly.js";
import { folderGitlabBaseUrlKey, folderLocalOnlyKey, folderStateKey, folderUri, readFolderInitialized, readFolderOptOut, readFolderSources, writeFolderSetting } from "./folderConfig.js";

export interface FolderSessionDeps {
  listFiles?: typeof listFiles;
  writeFile?: typeof writeFile;
  removeFile?: typeof removeFile;
  renameFile?: typeof renameFile;
  watch?: (target: string, options: { ignoreInitial: boolean; awaitWriteFinish: { stabilityThreshold: number; pollInterval: number } }) => FSWatcher;
}

export interface FolderSessionHost {
  trusted(): boolean;
  githubToken(): Promise<string | undefined>;
  gitlabToken(host?: string): Promise<string | undefined>;
  gitlabHostAllowed(host?: string): boolean;
  approvedGitlabHosts(): string[];
  createGithub(token: string, signal: AbortSignal): RulesProvider;
  createGitlab(token: string, baseUrl: string, signal: AbortSignal): RulesProvider;
  refreshAccessToken(): Promise<string | undefined>;
  forgetGithubSession(): Promise<void>;
  forgetGitlabSession(host: string): Promise<void>;
  virtualDocuments: VirtualDocumentStore;
  deps: FolderSessionDeps;
  context: vscode.ExtensionContext;
  onChange(): void;
  selectAndOpenDashboard(folderUri: string): Promise<void>;
  updateCheck(): UpdateCheckSettings;
}

type RemoteSnapshot = { commit: string; entries: FileEntry[] };

export class FolderSession {
  readonly folder: vscode.WorkspaceFolder;
  readonly uri: string;
  readonly name: string;
  readonly root: string;
  #watcher: FSWatcher | undefined;
  #refreshing = false;
  #remote: RemoteSnapshot | undefined;
  #local: FileEntry[] = [];
  #localOnlyItems: FileEntry[] = [];
  #localOnly = new Set<string>();
  #disabled = new Set<string>();
  #plan: SyncPlan | undefined;
  #status: DashboardState["status"] = "unconfigured";
  #statusMessage = "Connect a rules repository to begin.";
  #lastCheckedAt: string | undefined;
  #sourceGeneration = 0;
  #refreshAbort = new AbortController();
  #manifestStatus: DashboardState["manifestStatus"] = "notChecked";
  #manifestMessage: string | undefined;
  #authorship = new Map<string, { createdBy: string; lastEditedBy: string }>();
  #authorshipGeneration = 0;
  #gitlabBaseUrl = "https://gitlab.com";

  constructor(folder: vscode.WorkspaceFolder, private readonly host: FolderSessionHost) {
    this.folder = folder;
    this.uri = folderUri(folder);
    this.name = folder.name;
    this.root = folder.uri.fsPath;
  }

  get lastCheckedAt(): string | undefined { return this.#lastCheckedAt; }
  get status(): DashboardState["status"] { return this.#status; }
  get gitlabBaseUrl(): string { return this.#gitlabBaseUrl; }

  source(): SourceSpec | undefined {
    return configuredSource(readFolderSources(this.folder));
  }

  projectInitialized(): boolean {
    return readFolderInitialized(this.folder);
  }

  summary(): DashboardFolder {
    return { uri: this.uri, name: this.name, configured: Boolean(this.source()), status: this.#status, incomingCount: this.#plan?.incoming.length ?? 0, localCount: this.#plan?.local.length ?? 0, conflictCount: this.#plan?.conflicts.length ?? 0 };
  }

  async initialize(): Promise<void> {
    this.bumpGeneration();
    this.#watcher?.close();
    this.#watcher = undefined;
    if (!this.host.trusted()) {
      this.#local = [];
      this.#localOnlyItems = [];
      this.#localOnly = new Set();
      this.#disabled = new Set();
      this.#status = "needsReview";
      this.#statusMessage = "Trust this workspace before RuleSync reads local files or talks to a git host.";
      this.host.onChange();
      return;
    }
    try {
      await this.loadLocal();
    } catch (error) {
      this.#local = [];
      this.#localOnlyItems = [];
      this.#localOnly = new Set();
      this.#disabled = new Set();
      this.fail(error);
      return;
    }
    await this.startWatching();
    this.#lastCheckedAt = this.state().lastCheckedAt ?? this.#lastCheckedAt;
    this.#gitlabBaseUrl = this.selectedGitlabBaseUrl();
    if (this.sourceNeedsHostApproval()) {
      this.#status = "needsReview";
      this.#statusMessage = `Approve ${this.sourceGitlabHost()} before RuleSync uses this folder source.`;
      this.rebuildPlan();
      this.host.onChange();
      return;
    }
    if (this.source()) {
      this.#status = "checking";
      this.#statusMessage = "Ready to check the configured source.";
      this.host.onChange();
      if (await this.sessionToken()) await this.maybeRefresh("start");
      else {
        this.#status = "needsReview";
        this.#statusMessage = this.activeProvider() === "gitlab" ? "Paste a GitLab personal access token to check remote rules." : "Sign in to GitHub to check remote rules.";
        this.rebuildPlan();
        this.host.onChange();
      }
    } else {
      this.#status = "unconfigured";
      this.#statusMessage = this.projectInitialized() ? "Connect a shared rules repository." : "Initialize RuleSync for this folder.";
      this.#manifestStatus = "notChecked";
      this.#manifestMessage = undefined;
      this.rebuildPlan();
      this.host.onChange();
    }
  }

  dispose(): void {
    this.#refreshAbort.abort();
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  markNeedsReview(message: string): void {
    this.setStatus("needsReview", message);
  }

  setStatus(status: DashboardState["status"], message: string): void {
    this.#status = status;
    this.#statusMessage = message;
  }

  usesProvider(provider: ProviderId, host?: string): boolean {
    const source = this.source();
    if (source?.provider !== provider) return false;
    if (provider !== "gitlab" || !host) return true;
    try { return canonicalGitlabBaseUrl(source.baseUrl) === host; } catch { return false; }
  }

  toDashboardState(shared: {
    githubConnected: boolean;
    gitlabConnected: boolean;
    gitlabApprovedHosts: string[];
    availableRepositories: AvailableRepository[];
    repositoriesStatus: DashboardState["repositoriesStatus"];
    repositoriesProvider?: ProviderId;
    repositoriesMessage?: string;
    updateCheck: UpdateCheckSettings;
    folders: DashboardFolder[];
    selectedFolderUri?: string;
    legacyWorkspaceSource?: LegacyWorkspaceSource;
  }): DashboardState {
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
        lastEditedBy: authorship?.lastEditedBy,
        disabled: this.#disabled.has(itemPath),
        inWorkspace: this.#local.some((entry) => entry.path === itemPath)
      };
    });
    for (const entry of this.#localOnlyItems) {
      const folder = path.dirname(entry.path);
      items.push({ path: entry.path, name: path.basename(entry.path), type: classifyCursorPath(entry.path), status: "synced", detail: folder === "." ? undefined : folder, disabled: this.#disabled.has(entry.path), localOnly: true, inWorkspace: true });
    }
    items.sort((left, right) => left.path.localeCompare(right.path));
    return {
      configured: Boolean(source),
      projectInitialized: this.projectInitialized(),
      workspaceName: this.name,
      hasLocalCursorConfiguration: this.#local.length + this.#localOnlyItems.length > 0,
      githubConnected: shared.githubConnected,
      gitlabConnected: shared.gitlabConnected,
      gitlabBaseUrl: this.#gitlabBaseUrl,
      gitlabApprovedHosts: shared.gitlabApprovedHosts,
      manifestStatus: this.#manifestStatus,
      manifestMessage: this.#manifestMessage,
      trusted: this.host.trusted(),
      source,
      repositoryUrl: source ? this.repositoryUrlFor(source) : undefined,
      branch: source?.ref,
      profile: source?.profile,
      status: this.#status,
      statusMessage: this.#statusMessage,
      lastCheckedAt: this.#lastCheckedAt,
      updateCheck: shared.updateCheck,
      items,
      incomingCount: this.#plan?.incoming.length ?? 0,
      localCount: this.#plan?.local.length ?? 0,
      conflictCount: this.#plan?.conflicts.length ?? 0,
      warningCount: this.#plan?.risks.length ?? 0,
      proposedCount: state.activeProposal ? this.#plan?.local.length ?? 0 : 0,
      risks: this.#plan?.risks ?? [],
      activeProposal: state.activeProposal,
      availableRepositories: shared.availableRepositories,
      repositoriesStatus: shared.repositoriesStatus,
      repositoriesProvider: shared.repositoriesProvider,
      repositoriesMessage: shared.repositoriesMessage,
      folders: shared.folders,
      selectedFolderUri: shared.selectedFolderUri,
      legacyWorkspaceSource: shared.legacyWorkspaceSource
    };
  }

  async handle(command: DashboardCommand): Promise<void> {
    switch (command.type) {
      case "workspace.initialize": await this.initializeWorkspace(); return;
      case "manifest.initialize": await this.refresh(); return;
      case "source.save": await this.saveSource(command.source); return;
      case "sync.refresh": await this.maybeRefresh("manual"); return;
      case "content.open": await this.open(command.path); return;
      case "content.diff": await this.diff(command.path, command.comparison); return;
      case "content.create": await this.create(command.request); return;
      case "content.localOnly": await this.setLocalOnly(command.path, command.enabled); return;
      case "content.disable": await this.disable(command.path); return;
      case "content.enable": await this.enable(command.path); return;
      case "content.rename": await this.rename(command.path); return;
      case "content.delete": await this.delete(command.path); return;
      case "content.revert": await this.revert(command.path); return;
      case "conflict.resolve": await this.resolve(command.path, command.resolution); return;
      case "remote.apply": await this.applyOne(command.path); return;
      case "remote.applyAll": await this.applyAll(); return;
      case "remote.restore": await this.restoreRemote(); return;
      case "risks.accept": await this.acceptVisibleRisks(); return;
      case "risk.accept": await this.acceptOneRisk(command.path, command.code); return;
      case "proposal.publish": await this.publishProposal(command.message); return;
      case "proposal.openCompare": await this.openCompare(); return;
      case "source.disconnect": await this.disconnect(); return;
      default: return;
    }
  }

  async maybeRefresh(trigger: UpdateCheckTrigger): Promise<void> {
    if (!this.host.trusted()) return;
    const settings = this.host.updateCheck();
    if (!shouldRunUpdateCheck(settings, trigger)) return;
    if (trigger === "timer" && !isUpdateCheckDue(this.#lastCheckedAt, updateCheckIntervalMs(settings.interval))) return;
    if ((trigger === "focus" || trigger === "dashboard") && !isUpdateCheckDue(this.#lastCheckedAt, 2 * 60_000)) return;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.#refreshing || !this.source() || !this.host.trusted()) return;
    if (this.sourceNeedsHostApproval()) {
      this.#status = "needsReview";
      this.#statusMessage = `Approve ${this.sourceGitlabHost()} before RuleSync uses this folder source.`;
      this.host.onChange();
      return;
    }
    const token = await this.sessionToken();
    if (!token) { this.#status = "needsReview"; this.#statusMessage = this.activeProvider() === "gitlab" ? "Paste a GitLab personal access token to check remote rules." : "Sign in to GitHub to check remote rules."; this.host.onChange(); return; }
    const generation = this.#sourceGeneration;
    const identity = this.sourceIdentity();
    const source = this.source()!;
    this.#refreshing = true;
    this.#status = "checking";
    this.#statusMessage = "Checking remote rules…";
    this.publish(generation, identity);
    try {
      await this.withProvider(async (provider) => {
        if (!this.currentWork(generation, identity)) return;
        let repository: { defaultBranch: string; fullName: string };
        try {
          repository = await provider.verifyRepository(source.repository);
        } catch (error) {
          if (isNotFound(error) || isForbidden(error)) throw new Error(this.activeProvider() === "gitlab" ? "RuleSync cannot access this project. Check the path and token scopes." : "RuleSync cannot access this repository. Install the RuleSync GitHub App on it, then check again.");
          throw error;
        }
        if (!this.currentWork(generation, identity)) return;
        const branch = source.ref || repository.defaultBranch;
        let commit: string;
        try {
          commit = await provider.getRef(source.repository, branch);
        } catch (error) {
          if ((isNotFound(error) || isConflict(error)) && await provider.isEmptyRepository(source.repository)) {
            if (!this.currentWork(generation, identity)) return;
            this.#remote = undefined;
            this.#manifestStatus = "empty";
            this.#manifestMessage = `${source.repository} has no ${branch} branch. Create ${branch} on ${this.hostLabel()} first.`;
            this.rebuildPlan();
            this.#lastCheckedAt = new Date().toISOString();
            this.#status = "needsReview";
            this.#statusMessage = this.#manifestMessage;
            this.publish(generation, identity);
            return;
          }
          throw error;
        }
        if (!this.currentWork(generation, identity)) return;
        const tree = await provider.getTree(source.repository, commit, cursorLocalRoot());
        if (!this.currentWork(generation, identity)) return;
        const candidates = tree.filter((entry) => { try { assertManagedCursorPath(entry.path); return !isLocalOnlyPath(entry.path, this.#localOnly); } catch { return false; } });
        if (candidates.length > managedFileCap) throw limitError("This repository has too many managed files for RuleSync to sync safely.");
        let declared = 0;
        for (const entry of candidates) {
          if ((entry.size ?? 0) > maxFileBytes) throw limitError("A remote file exceeded the 5 MiB sync limit.");
          declared += entry.size ?? 0;
        }
        if (declared > maxAggregateBytes) throw limitError("Remote .cursor content exceeded the 20 MiB sync limit.");
        const entries = await mapLimited(candidates, blobConcurrency, async (entry) => {
          const content = await provider.getBlob(source.repository, entry.oid);
          if (content.byteLength > maxFileBytes) throw limitError("A remote file exceeded the 5 MiB sync limit.");
          return { path: entry.path, content, contentHash: hash(content), size: content.byteLength, mode: entry.mode } satisfies FileEntry;
        });
        if (entries.reduce((total, entry) => total + entry.size, 0) > maxAggregateBytes) throw limitError("Remote .cursor content exceeded the 20 MiB sync limit.");
        if (!this.currentWork(generation, identity)) return;
        this.#remote = { commit, entries };
        this.#manifestStatus = "ready";
        this.#manifestMessage = undefined;
        const state = this.state();
        for (const local of this.#local) {
          const remote = entries.find((entry) => entry.path === local.path);
          if (remote && remote.contentHash === local.contentHash && !state.entries[local.path]) state.entries[local.path] = { remoteOid: remote.contentHash, localHash: local.contentHash, mode: local.mode };
        }
        await this.saveState(state, generation, identity);
        if (!this.currentWork(generation, identity)) return;
        this.rebuildPlan();
        if (state.activeProposal) {
          const pullRequest = await provider.findReviewRequest(source.repository, state.activeProposal.branch);
          if (!this.currentWork(generation, identity)) return;
          if (pullRequest) state.activeProposal.pullRequest = pullRequest;
          else if (!shouldKeepProposal(false, this.#plan?.local.length ?? 0)) delete state.activeProposal;
          await this.saveState(state, generation, identity);
        }
        this.#lastCheckedAt = new Date().toISOString();
        state.lastCheckedAt = this.#lastCheckedAt;
        await this.saveState(state, generation, identity);
        if (!this.currentWork(generation, identity)) return;
        const plan = this.#plan;
        this.#status = plan && (plan.conflicts.length || plan.incoming.length || plan.local.length) ? "needsReview" : "synced";
        this.#statusMessage = this.#status === "synced" ? "Everything is synchronized." : "Changes are ready for review.";
        this.publish(generation, identity);
        void this.notifyRemoteUpdates(state, generation, identity);
        void this.loadAuthorship(generation, identity);
      });
    } catch (error) {
      this.fail(error, generation, identity);
    } finally {
      if (generation === this.#sourceGeneration) this.#refreshing = false;
    }
  }

  private activeProvider(): ProviderId {
    return this.source()?.provider ?? (this.#gitlabBaseUrl !== "https://gitlab.com" ? "gitlab" : "github");
  }

  private hostLabel(): "GitHub" | "GitLab" {
    return this.activeProvider() === "gitlab" ? "GitLab" : "GitHub";
  }

  private reviewNoun(): "pull request" | "merge request" {
    return this.activeProvider() === "gitlab" ? "merge request" : "pull request";
  }

  private sourceGitlabHost(): string | undefined {
    const source = this.source();
    if (source?.provider !== "gitlab") return undefined;
    try { return canonicalGitlabBaseUrl(source.baseUrl); } catch { return undefined; }
  }

  private sourceNeedsHostApproval(): boolean {
    const host = this.sourceGitlabHost();
    return Boolean(host && !this.host.gitlabHostAllowed(host));
  }

  private selectedGitlabBaseUrl(): string {
    if (!this.host.trusted()) return "https://gitlab.com";
    const sourceHost = this.sourceGitlabHost();
    if (sourceHost) return sourceHost;
    const remembered = this.host.context.workspaceState.get<string>(folderGitlabBaseUrlKey(this.uri));
    try {
      const host = canonicalGitlabBaseUrl(remembered);
      return this.host.gitlabHostAllowed(host) ? host : "https://gitlab.com";
    } catch { return "https://gitlab.com"; }
  }

  private repositoryUrlFor(source: SourceSpec): string {
    if (source.provider !== "gitlab") return `https://github.com/${source.repository}`;
    try { return `${canonicalGitlabBaseUrl(source.baseUrl)}/${source.repository}`; } catch { return source.repository; }
  }

  private optOut(): string[] {
    const source = this.source();
    if (!source) return [];
    return readFolderOptOut(this.folder).find((entry) => entry.source === source.id)?.paths ?? [];
  }

  private state(): SyncState {
    const stored = this.host.context.workspaceState.get<SyncState>(folderStateKey(this.uri));
    return stored && stored.sourceIdentity === this.sourceIdentity() ? stored : { schemaVersion: 1, sourceIdentity: this.sourceIdentity(), entries: {} };
  }

  private sourceIdentity(): string {
    return sourceIdentity(this.source());
  }

  private currentWork(generation: number, identity: string): boolean {
    return generation === this.#sourceGeneration && identity === this.sourceIdentity();
  }

  private bumpGeneration(): void {
    this.#sourceGeneration += 1;
    this.#refreshAbort.abort();
    this.#refreshAbort = new AbortController();
    this.#refreshing = false;
    this.#remote = undefined;
    this.#plan = undefined;
    this.#authorship.clear();
    this.#authorshipGeneration += 1;
    this.#manifestStatus = "notChecked";
    this.#manifestMessage = undefined;
  }

  private async saveState(next: SyncState, generation?: number, identity?: string): Promise<void> {
    if (generation !== undefined && identity !== undefined && !this.currentWork(generation, identity)) return;
    await this.host.context.workspaceState.update(folderStateKey(this.uri), next);
  }

  private async sessionToken(): Promise<string | undefined> {
    if (this.sourceNeedsHostApproval()) return undefined;
    return this.activeProvider() === "gitlab" ? this.host.gitlabToken(this.#gitlabBaseUrl) : this.host.githubToken();
  }

  private async withGithub<T>(run: (github: RulesProvider) => Promise<T>): Promise<T> {
    const token = await this.host.githubToken();
    if (!token) throw new Error("Sign in to GitHub to continue.");
    try { return await run(this.host.createGithub(token, this.#refreshAbort.signal)); } catch (error) {
      if (!isUnauthorized(error)) throw error;
      const next = await this.host.refreshAccessToken();
      if (!next) {
        await this.host.forgetGithubSession();
        throw new Error("GitHub sign-in expired. Connect GitHub again.");
      }
      return run(this.host.createGithub(next, this.#refreshAbort.signal));
    }
  }

  private async withGitlab<T>(run: (gitlab: RulesProvider) => Promise<T>): Promise<T> {
    if (!this.host.gitlabHostAllowed(this.#gitlabBaseUrl)) throw new Error(`Approve ${this.#gitlabBaseUrl} before connecting GitLab.`);
    const token = await this.host.gitlabToken(this.#gitlabBaseUrl);
    if (!token) throw new Error("Connect GitLab before choosing a repository.");
    try { return await run(this.host.createGitlab(token, this.#gitlabBaseUrl, this.#refreshAbort.signal)); } catch (error) {
      if (!isUnauthorized(error)) throw error;
      await this.host.forgetGitlabSession(this.#gitlabBaseUrl);
      throw new Error("GitLab token expired or was revoked. Paste a new personal access token.");
    }
  }

  private async withProvider<T>(run: (provider: RulesProvider) => Promise<T>): Promise<T> {
    return this.activeProvider() === "gitlab" ? this.withGitlab(run) : this.withGithub(run);
  }

  private assertTrusted(): void {
    if (!this.host.trusted()) throw new Error("Trust this workspace before RuleSync reads or writes local files.");
  }

  private localOnlyPaths(): string[] {
    return parseLocalOnlyRegistry(this.host.context.workspaceState.get(folderLocalOnlyKey(this.uri)));
  }

  private async saveLocalOnlyPaths(paths: readonly string[]): Promise<void> {
    const next = serializeLocalOnlyRegistry(paths);
    await this.host.context.workspaceState.update(folderLocalOnlyKey(this.uri), next.paths.length ? next : undefined);
    this.#localOnly = new Set(next.paths);
  }

  private localEntry(itemPath: string): FileEntry | undefined {
    return this.#local.find((entry) => entry.path === itemPath) ?? this.#localOnlyItems.find((entry) => entry.path === itemPath);
  }

  private async loadLocal(): Promise<void> {
    let registry: string[];
    try { registry = this.localOnlyPaths(); } catch (error) {
      this.#local = [];
      this.#localOnlyItems = [];
      this.#localOnly = new Set();
      this.#disabled = new Set();
      this.#plan = undefined;
      throw error;
    }
    this.#localOnly = new Set(registry);
    const { entries, disabled } = foldLocalDisabled(await (this.host.deps.listFiles ?? listFiles)(this.root));
    this.#disabled = new Set(disabled);
    this.#local = excludeLocalOnly(entries, this.#localOnly);
    this.#localOnlyItems = entries.filter((entry) => this.#localOnly.has(entry.path));
  }

  private diskPath(canonical: string): string {
    return diskManagedPath(canonical, this.#disabled.has(canonical));
  }

  private async writeManaged(entry: FileEntry): Promise<void> {
    await (this.host.deps.writeFile ?? writeFile)(this.root, { ...entry, path: this.diskPath(entry.path) });
  }

  private async removeManaged(canonical: string): Promise<void> {
    await (this.host.deps.removeFile ?? removeFile)(this.root, this.diskPath(canonical));
  }

  private async startWatching(): Promise<void> {
    const target = path.join(this.root, cursorLocalRoot());
    if (this.host.deps.watch) this.#watcher = this.host.deps.watch(target, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 750, pollInterval: 100 } });
    else {
      await assertSafeManagedPath(this.root, cursorLocalRoot());
      this.#watcher = chokidar.watch(target, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 750, pollInterval: 100 } });
    }
    this.#watcher.on("all", () => void this.onLocalChange());
  }

  private async notifyRemoteUpdates(state: SyncState, generation: number, identity: string): Promise<void> {
    const plan = this.#plan;
    if (!plan || !this.currentWork(generation, identity)) return;
    const incomingKeys = plan.incoming.map((change) => changeKey(change.path, change.remote?.contentHash));
    const conflictKeys = plan.conflicts.map((change) => changeKey(change.path, change.remote?.contentHash));
    const keys = [...incomingKeys, ...conflictKeys];
    const fresh = unseenKeys(state.notifiedIncoming, keys);
    state.notifiedIncoming = keys;
    await this.saveState(state, generation, identity);
    if (!fresh.length) return;
    const incoming = incomingKeys.filter((key) => fresh.includes(key)).length;
    const conflicts = conflictKeys.filter((key) => fresh.includes(key)).length;
    const message = remoteUpdateMessage(incoming, conflicts);
    if (!message) return;
    const answer = await vscode.window.showInformationMessage(`${this.name}: ${message}`, "Review");
    if (answer === "Review") await this.host.selectAndOpenDashboard(this.uri);
  }

  private async onLocalChange(): Promise<void> {
    try {
      await this.loadLocal();
      this.rebuildPlan();
      if (this.source()) {
        this.#status = this.#plan && (this.#plan.local.length || this.#plan.conflicts.length) ? "needsReview" : "synced";
        this.#statusMessage = this.#plan?.local.length ? "Local changes are ready for review." : this.#statusMessage;
      }
      this.host.onChange();
    } catch (error) { this.fail(error); }
  }

  private rebuildPlan(): void {
    const remote = excludeLocalOnly(this.#remote?.entries ?? [], this.#localOnly);
    this.#plan = planSync({ baseline: this.state().entries, local: this.#local, remote, optOut: this.optOut(), classify: classifyCursorPath, risks: scanRisks([...this.#local, ...remote]), acceptedRisks: this.state().acceptedRisks });
  }

  private contentHashes(): Map<string, string> {
    const hashes = new Map<string, string>();
    for (const entry of this.#remote?.entries ?? []) hashes.set(entry.path, entry.contentHash);
    for (const entry of this.#local) hashes.set(entry.path, entry.contentHash);
    return hashes;
  }

  private outstandingRisks(paths?: readonly string[]): RiskFinding[] {
    return (this.#plan?.risks ?? []).filter((risk) => !paths || paths.includes(risk.path));
  }

  private async acceptVisibleRisks(): Promise<void> {
    if (!this.#plan?.risks.length) return;
    const state = this.state();
    state.acceptedRisks = acceptRisks(state.acceptedRisks, this.#plan.risks, this.contentHashes());
    await this.saveState(state);
    this.rebuildPlan();
    this.host.onChange();
  }

  private async acceptOneRisk(itemPath: string, code: string): Promise<void> {
    const risk = this.#plan?.risks.find((item) => item.path === itemPath && item.code === code);
    if (!risk || !isHighRisk(risk)) throw new Error("That high-risk finding is no longer current.");
    const answer = await vscode.window.showWarningMessage(`Accept ${path.basename(itemPath)} (${code}) for the current file contents?`, { modal: true }, "Accept");
    if (answer !== "Accept") return;
    const state = this.state();
    state.acceptedRisks = acceptRisks(state.acceptedRisks, [risk], this.contentHashes(), { highRisk: true });
    await this.saveState(state);
    this.rebuildPlan();
    this.host.onChange();
  }

  private async loadAuthorship(generation: number, identity: string): Promise<void> {
    const authorshipGeneration = ++this.#authorshipGeneration;
    const source = this.source();
    const remote = this.#remote;
    if (!source || !remote || !this.currentWork(generation, identity)) return;
    if (remote.entries.length > authorshipCap) return;
    const missing = remote.entries.filter((entry) => !this.#authorship.has(`${entry.path}@${entry.contentHash}`));
    if (!missing.length) return;
    try {
      await this.withProvider(async (provider) => {
        for (let index = 0; index < missing.length; index += 5) {
          if (authorshipGeneration !== this.#authorshipGeneration || !this.currentWork(generation, identity)) return;
          await Promise.all(missing.slice(index, index + 5).map(async (entry) => {
            try {
              const info = await provider.getFileAuthorship(source.repository, entry.path, remote.commit);
              if (info && authorshipGeneration === this.#authorshipGeneration) this.#authorship.set(`${entry.path}@${entry.contentHash}`, info);
            } catch { /* leave the row without git authors */ }
          }));
          if (authorshipGeneration === this.#authorshipGeneration && this.currentWork(generation, identity)) this.host.onChange();
        }
      });
    } catch { /* authorship is additive */ }
  }

  private publish(generation?: number, identity?: string): void {
    if (generation !== undefined && identity !== undefined && !this.currentWork(generation, identity)) return;
    this.host.onChange();
  }

  private fail(error: unknown, generation?: number, identity?: string): void {
    if (generation !== undefined && identity !== undefined && !this.currentWork(generation, identity)) return;
    if (this.#refreshAbort.signal.aborted && !isTimeoutAbort(this.#refreshAbort.signal)) return;
    if (isUnauthorized(error)) {
      if (this.activeProvider() === "gitlab") void this.host.forgetGitlabSession(this.#gitlabBaseUrl);
      else void this.host.forgetGithubSession();
      this.#status = "needsReview";
      this.#statusMessage = providerUserMessage(this.activeProvider(), error);
      this.host.onChange();
      return;
    }
    this.#status = "error";
    this.#statusMessage = providerUserMessage(this.activeProvider(), error);
    this.host.onChange();
  }

  private async initializeWorkspace(): Promise<void> {
    this.assertTrusted();
    await writeFolderSetting(this.folder, "projectInitialized", true);
    this.#status = "unconfigured";
    this.#statusMessage = this.#local.length ? "This folder has Cursor configuration ready to share." : "Folder initialized. Connect a shared rules repository next.";
    this.host.onChange();
  }

  rememberGitlabHost(host: string): void {
    this.#gitlabBaseUrl = host;
  }

  private async saveSource(source: SourceSpec): Promise<void> {
    this.assertTrusted();
    if (!source.repository || !source.profile) throw new Error("Repository and profile are required.");
    if (source.provider === "gitlab") {
      const host = canonicalGitlabBaseUrl(source.baseUrl);
      if (!this.host.gitlabHostAllowed(host)) throw new Error(`Approve ${host} before choosing a repository.`);
      if (!await this.host.gitlabToken(host)) throw new Error("Connect GitLab before choosing a repository.");
      source = { ...source, baseUrl: host };
      this.#gitlabBaseUrl = host;
      await this.host.context.workspaceState.update(folderGitlabBaseUrlKey(this.uri), host);
    } else if (source.provider !== "github") throw new Error("Repository and profile are required.");
    this.bumpGeneration();
    await writeFolderSetting(this.folder, "projectInitialized", true);
    await writeFolderSetting(this.folder, "sources", [{ ...source, profile: source.profile || "cursor-project", enabled: true }]);
    await this.saveState({ schemaVersion: 1, sourceIdentity: this.sourceIdentity(), entries: {} });
    await this.initialize();
  }

  private async open(itemPath: string): Promise<void> {
    const local = this.localEntry(itemPath);
    if (local) await vscode.window.showTextDocument(vscode.Uri.file(workspacePath(this.root, this.diskPath(itemPath))), { preview: true });
    else {
      const remote = this.#remote?.entries.find((entry) => entry.path === itemPath);
      if (remote) await vscode.window.showTextDocument(this.host.virtualDocuments.set("rulesync-remote", this.uri, itemPath, remote.content), { preview: true });
    }
  }

  private async diff(itemPath: string, comparison: "remote" | "base"): Promise<void> {
    const remote = this.#remote?.entries.find((entry) => entry.path === itemPath);
    const local = this.localEntry(itemPath);
    if (!remote && !local) return;
    const incoming = comparison === "remote" && this.#plan?.changes.find((change) => change.path === itemPath)?.status === "incoming";
    const remoteUri = this.host.virtualDocuments.set("rulesync-remote", this.uri, itemPath, remote?.content);
    const localUri = local ? vscode.Uri.file(workspacePath(this.root, this.diskPath(itemPath))) : this.host.virtualDocuments.set("rulesync-base", this.uri, itemPath, undefined);
    if (incoming) {
      await vscode.commands.executeCommand("vscode.diff", localUri, remoteUri, `Local → Remote: ${path.basename(itemPath)}`);
      return;
    }
    await vscode.commands.executeCommand("vscode.diff", remoteUri, localUri, `${comparison === "remote" ? "Remote" : "Baseline"} ↔ Local: ${path.basename(itemPath)}`);
  }

  private async create(request: Extract<DashboardCommand, { type: "content.create" }> ["request"]): Promise<void> {
    this.assertTrusted();
    const content = createCursorContent(request);
    await (this.host.deps.writeFile ?? writeFile)(this.root, { path: content.path, content: new TextEncoder().encode(content.contents), contentHash: "", size: content.contents.length, mode: content.mode });
    if (request.localOnly) {
      try { await this.saveLocalOnlyPaths([...this.#localOnly, content.path]); } catch (error) {
        await (this.host.deps.removeFile ?? removeFile)(this.root, content.path);
        throw error;
      }
    }
    await this.onLocalChange();
    await this.open(content.path);
  }

  private async setLocalOnly(itemPath: string, enabled: boolean): Promise<void> {
    this.assertTrusted();
    const canonical = assertManagedCursorPath(itemPath);
    if (enabled) {
      if (!this.localEntry(canonical)) throw new Error("This file is not in the workspace.");
      if (this.#localOnly.has(canonical)) return;
      const answer = await vscode.window.showWarningMessage(`Stop syncing ${path.basename(canonical)}? Cursor will still use the file. Future proposals will ignore it.`, { modal: true }, "Make local only");
      if (answer !== "Make local only") return;
      await this.saveLocalOnlyPaths([...this.#localOnly, canonical]);
      const state = this.state();
      if (state.entries[canonical]) {
        delete state.entries[canonical];
        await this.saveState(state);
      }
      if (this.#remote) this.#remote = { ...this.#remote, entries: excludeLocalOnly(this.#remote.entries, this.#localOnly) };
      await this.onLocalChange();
      return;
    }
    if (!this.#localOnly.has(canonical)) return;
    await this.saveLocalOnlyPaths([...this.#localOnly].filter((entry) => entry !== canonical));
    await this.loadLocal();
    if (this.source()) { await this.refresh(); return; }
    this.rebuildPlan();
    this.host.onChange();
  }

  private async disable(itemPath: string): Promise<void> {
    this.assertTrusted();
    const canonical = assertManagedCursorPath(itemPath);
    if (this.#disabled.has(canonical)) throw new Error("This file is already disabled.");
    if (!this.localEntry(canonical)) throw new Error("This file is not in the workspace.");
    this.rebuildPlan();
    if (this.#plan?.changes.find((change) => change.path === canonical)?.status === "optedOut") throw new Error("Opted-out files cannot be disabled.");
    if (!canDisableManagedPath(canonical)) throw new Error("Hook scripts cannot be disabled. Disable .cursor/hooks.json to turn off project hooks.");
    if (this.#remote?.entries.some((entry) => entry.path === disabledDiskPath(canonical))) throw new Error("The remote already has a file at the disabled path.");
    await (this.host.deps.renameFile ?? renameFile)(this.root, canonical, disabledDiskPath(canonical));
    await this.onLocalChange();
  }

  private async enable(itemPath: string): Promise<void> {
    this.assertTrusted();
    const canonical = assertManagedCursorPath(itemPath);
    if (!this.#disabled.has(canonical)) throw new Error("This file is not disabled.");
    await (this.host.deps.removeFile ?? removeFile)(this.root, canonical);
    await (this.host.deps.renameFile ?? renameFile)(this.root, disabledDiskPath(canonical), canonical);
    await this.onLocalChange();
  }

  private async rename(previous: string): Promise<void> {
    this.assertTrusted();
    if (!this.localEntry(previous)) throw new Error("Pull this file before renaming it.");
    const typed = await vscode.window.showInputBox({ title: "Rename managed file", prompt: "New path under .cursor", value: previous, validateInput: (value) => { try { managedRenamePath(previous, value); return; } catch (error) { return error instanceof Error ? error.message : "Invalid path"; } } });
    if (!typed) return;
    const next = managedRenamePath(previous, typed);
    if (this.localEntry(next)) throw new Error("A managed file already exists at that path.");
    const from = this.diskPath(previous);
    const to = diskManagedPath(next, this.#disabled.has(previous));
    await (this.host.deps.renameFile ?? renameFile)(this.root, from, to);
    if (this.#localOnly.has(previous)) {
      try { await this.saveLocalOnlyPaths([...this.#localOnly].filter((entry) => entry !== previous).concat(next)); } catch (error) {
        await (this.host.deps.renameFile ?? renameFile)(this.root, to, from);
        throw error;
      }
    }
    await this.onLocalChange();
  }

  private async delete(itemPath: string): Promise<void> {
    this.assertTrusted();
    const localOnly = this.#localOnly.has(itemPath);
    const answer = await vscode.window.showWarningMessage(localOnly ? `Delete ${path.basename(itemPath)} locally? RuleSync is not tracking this file.` : `Delete ${path.basename(itemPath)} locally? This will become a proposal change.`, { modal: true }, "Delete");
    if (answer !== "Delete") return;
    await this.removeManaged(itemPath);
    if (localOnly) await this.saveLocalOnlyPaths([...this.#localOnly].filter((entry) => entry !== itemPath));
    await this.onLocalChange();
    if (localOnly && this.source()) await this.refresh();
  }

  private async revert(itemPath: string): Promise<void> {
    this.assertTrusted();
    if (this.#localOnly.has(itemPath)) throw new Error("This file is local only.");
    const local = this.#local.find((entry) => entry.path === itemPath);
    const remote = this.#remote?.entries.find((entry) => entry.path === itemPath);
    if (!local && !remote) throw new Error("This file is not in the workspace.");
    const name = path.basename(itemPath);
    if (remote) {
      const answer = await vscode.window.showWarningMessage(local ? `Revert ${name} to the remote version? Local edits will be lost.` : `Restore ${name} from remote?`, { modal: true }, local ? "Revert" : "Restore");
      if (answer !== (local ? "Revert" : "Restore")) return;
      await this.writeManaged(remote);
    } else {
      const answer = await vscode.window.showWarningMessage(`Discard ${name}? This new local file will be deleted.`, { modal: true }, "Discard");
      if (answer !== "Discard") return;
      await this.removeManaged(itemPath);
    }
    await this.onLocalChange();
  }

  private async resolve(itemPath: string, resolution: "local" | "remote"): Promise<void> {
    if (this.#localOnly.has(itemPath)) throw new Error("This file is local only.");
    const remote = this.#remote?.entries.find((entry) => entry.path === itemPath);
    if (!remote) throw new Error("Remote content is unavailable for this conflict.");
    if (resolution === "remote") {
      this.assertTrusted();
      await this.writeManaged(remote);
      await this.onLocalChange();
      return;
    }
    const state = this.state();
    state.entries[itemPath] = { remoteOid: remote.contentHash, localHash: remote.contentHash, mode: remote.mode };
    await this.saveState(state);
    this.rebuildPlan();
    this.host.onChange();
  }

  private async applyOne(itemPath: string): Promise<void> {
    if (this.#localOnly.has(itemPath)) throw new Error("This file is local only.");
    if (!await this.writeIncoming([itemPath])) return;
    this.#status = this.#plan?.incoming.length || this.#plan?.local.length || this.#plan?.conflicts.length ? "needsReview" : "synced";
    this.#statusMessage = `Pulled ${path.basename(itemPath)}.`;
    this.host.onChange();
  }

  private async restoreRemote(): Promise<void> {
    this.assertTrusted();
    if (!this.source()) throw new Error("Connect a rules source first.");
    await this.refresh();
    if (!this.#remote) throw new Error("Check remote rules before restoring.");
    const answer = await vscode.window.showWarningMessage(`Replace ${this.name}’s .cursor files with the remote versions? Local edits and deletions will be lost.`, { modal: true }, "Restore");
    if (answer !== "Restore") return;
    await this.loadLocal();
    const extras = this.#local.filter((entry) => !this.#remote!.entries.some((remote) => remote.path === entry.path)).map((entry) => entry.path);
    const risky = this.outstandingRisks([...this.#remote.entries.map((entry) => entry.path), ...extras]);
    if (risky.some((risk) => risk.code === "large" || isHighRisk(risk))) throw new Error("Accept each high-risk file before restoring from remote.");
    if (risky.length) throw new Error("Accept outstanding safety findings before restoring from remote.");
    for (const remote of this.#remote.entries) await this.writeManaged(remote);
    for (const extra of extras) await this.removeManaged(extra);
    await this.loadLocal();
    const state = this.state();
    state.entries = Object.fromEntries(this.#remote.entries.map((entry) => [entry.path, { remoteOid: entry.contentHash, localHash: entry.contentHash, mode: entry.mode }]));
    state.baselineCommit = this.#remote.commit;
    await this.saveState(state);
    this.rebuildPlan();
    this.#status = this.#plan?.local.length || this.#plan?.incoming.length || this.#plan?.conflicts.length ? "needsReview" : "synced";
    this.#statusMessage = this.#status === "synced" ? "Restored from remote." : "Restored from remote. Some changes still need review.";
    this.host.onChange();
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
    this.host.onChange();
  }

  private async writeIncoming(paths: readonly string[]): Promise<boolean> {
    this.assertTrusted();
    if (!this.#plan || !this.#remote) throw new Error("Check remote rules before applying updates.");
    const incoming = new Set(this.#plan.incoming.map((change) => change.path));
    for (const itemPath of paths) {
      assertManagedCursorPath(itemPath);
      if (this.#localOnly.has(itemPath)) throw new Error("This file is local only.");
      if (!incoming.has(itemPath)) throw new Error(`${path.basename(itemPath)} is not waiting to be pulled.`);
    }
    const risky = this.outstandingRisks(paths);
    if (risky.some((risk) => risk.code === "large" || isHighRisk(risk))) throw new Error("Accept each high-risk file before applying remote updates.");
    if (risky.length) throw new Error("Accept outstanding safety findings before applying remote updates.");
    for (const itemPath of paths) {
      const remote = this.#remote.entries.find((entry) => entry.path === itemPath);
      if (remote) await this.writeManaged(remote);
      else {
        await this.removeManaged(itemPath);
        if (this.#disabled.has(itemPath)) await (this.host.deps.removeFile ?? removeFile)(this.root, itemPath);
      }
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
    const token = await this.sessionToken();
    if (!source || !token || !this.#plan) throw new Error("Connect and refresh a rules source before publishing.");
    if (this.#manifestStatus === "empty" || !this.#remote) throw new Error(`Create the default branch for ${source.repository} on ${this.hostLabel()} first.`);
    if (this.#plan.incoming.length || this.#plan.conflicts.length) throw new Error("Review remote updates and conflicts before publishing local changes.");
    if (!this.#plan.local.length) throw new Error("There are no local changes to publish.");
    const risky = this.outstandingRisks(this.#plan.local.map((change) => change.path));
    if (risky.some((risk) => risk.code === "large" || isHighRisk(risk))) throw new Error("Accept each high-risk file before publishing.");
    if (risky.length) throw new Error("Accept outstanding safety findings before publishing.");
    const generation = this.#sourceGeneration;
    const identity = this.sourceIdentity();
    await this.withProvider(async (provider) => {
      if (!this.currentWork(generation, identity)) return;
      const verified = await provider.verifyRepository(source.repository);
      const baseBranch = source.ref || verified.defaultBranch;
      const latest = await provider.getRef(source.repository, baseBranch);
      if (!this.currentWork(generation, identity)) return;
      if (latest !== this.#remote!.commit) throw new Error("The remote branch changed. Refresh and review before publishing.");
      const state = this.state();
      const existing = state.activeProposal;
      if (existing) {
        const actualHead = await provider.getRef(source.repository, existing.branch);
        if (actualHead !== existing.headCommit) throw new Error(`The proposal branch changed outside RuleSync. Refresh it on ${this.hostLabel()} before updating.`);
      }
      if (!this.currentWork(generation, identity)) return;
      const branch = existing?.branch ?? `rulesync/${this.githubSafeName(await provider.authenticatedLogin())}/${this.branchTimestamp()}`;
      const proposal = await provider.createProposal({ repository: source.repository, baseBranch, baseCommit: this.#remote!.commit, branch, parentCommit: existing?.headCommit, updateExisting: Boolean(existing), message: message.trim() || proposalCommitMessage(this.#plan!.local), changes: this.#plan!.local.map((change) => ({ path: change.path, entry: this.#local.find((entry) => entry.path === change.path) })) });
      if (!this.currentWork(generation, identity)) return;
      state.activeProposal = proposal;
      await this.saveState(state, generation, identity);
      this.#status = "needsReview";
      this.#statusMessage = `Proposal branch is ready. Create the ${this.reviewNoun()} on ${this.hostLabel()}.`;
      this.publish(generation, identity);
    });
  }

  private githubSafeName(login: string): string { return login.toLowerCase().replace(/[^a-z0-9-]/g, "-") || "user"; }
  private branchTimestamp(): string { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, ""); }

  private async openCompare(): Promise<void> {
    const proposal = this.state().activeProposal;
    if (!proposal) throw new Error("Publish a proposal branch first.");
    await vscode.env.clipboard.writeText(proposalCommitMessage(this.#plan?.local ?? []));
    await vscode.env.openExternal(vscode.Uri.parse(proposal.pullRequest?.url ?? proposal.compareUrl));
  }

  async clearConfiguredSource(): Promise<void> {
    await writeFolderSetting(this.folder, "sources", []);
    await this.host.context.workspaceState.update(folderStateKey(this.uri), undefined);
    this.#remote = undefined;
    this.#manifestStatus = "notChecked";
    this.#manifestMessage = undefined;
  }

  private async disconnect(): Promise<void> {
    this.bumpGeneration();
    await this.clearConfiguredSource();
    await this.initialize();
  }
}
