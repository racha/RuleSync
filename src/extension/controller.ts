import * as vscode from "vscode";
import { GitLabProvider } from "@rulesync/provider-gitlab";
import { GitHubProvider, pollDeviceToken, refreshUserAccessToken, requestDeviceCode } from "@rulesync/provider-github";
import { canonicalGitlabBaseUrl, configuredSource, defaultUpdateCheck, gitlabPatSecretKey, isGitlabHostApproved, isUnauthorized, providerUserMessage, type AvailableRepository, type DashboardFolder, type DashboardState, type LegacyWorkspaceSource, type ProviderId, type RulesProvider, type UpdateCheckSettings, type UpdateCheckTrigger } from "@rulesync/core";

import { VirtualDocumentStore } from "./virtualDocuments.js";
import { commandGitlabHost, commandProvider, type DashboardCommand } from "./protocol.js";
import { FolderSession, type FolderSessionDeps, type FolderSessionHost } from "./folderSession.js";
import { assignLegacyWorkspaceSetup, discardLegacyWorkspaceSetup, eligibleFolders, folderGitlabBaseUrlKey, folderUri, hasLegacyWorkspaceSetup, inspectWorkspaceSources, isMultiRoot, migrateSingleFolderState, readLegacyAssignment, selectedFolderKey } from "./folderConfig.js";

const tokenKey = "rulesync.github.accessToken";
const refreshTokenKey = "rulesync.github.refreshToken";
const gitlabApprovedHostsKey = "rulesync.gitlab.approvedHosts.v1";
const bundledGithubAppClientId = "Iv23li1SFwqQ6d45EmWN";
const githubAppInstallUrl = "https://github.com/apps/rulesync/installations/select_target";
const gitlabPatHelpUrl = "https://docs.gitlab.com/user/profile/personal_access_tokens/";
const untrustedAllowed = new Set(["ready", "source.disconnect", "auth.forget", "gitlab.pat.forget", "settings.updateCheck", "proposal.openCompare", "folder.select"]);
const sessionCommands = new Set(["workspace.initialize", "manifest.initialize", "source.save", "source.disconnect", "sync.refresh", "content.open", "content.diff", "content.create", "content.disable", "content.enable", "content.rename", "content.delete", "content.revert", "conflict.resolve", "remote.apply", "remote.applyAll", "remote.restore", "risks.accept", "risk.accept", "proposal.publish", "proposal.openCompare"]);

export interface ControllerDeps extends FolderSessionDeps {
  createGithub?: (token: string, signal?: AbortSignal) => RulesProvider;
  createGitlab?: (input: { token: string; baseUrl: string; signal?: AbortSignal }) => RulesProvider;
  requestDeviceCode?: typeof requestDeviceCode;
  pollDeviceToken?: typeof pollDeviceToken;
  refreshUserAccessToken?: typeof refreshUserAccessToken;
}

function gitlabPatCreateUrl(baseUrl?: string): string {
  try {
    const host = canonicalGitlabBaseUrl(baseUrl);
    if (host === "https://gitlab.example.com") return gitlabPatHelpUrl;
    return `${host}/-/user_settings/personal_access_tokens?name=RuleSync&scopes=api`;
  } catch {
    return gitlabPatHelpUrl;
  }
}

export class RuleSyncController implements vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<DashboardState>();
  readonly #virtualDocuments = new VirtualDocumentStore();
  readonly #deps: ControllerDeps;
  readonly #sessions = new Map<string, FolderSession>();
  #selectedUri: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #githubConnected = false;
  #gitlabConnected = false;
  #repositoriesGeneration = 0;
  #availableRepositories: AvailableRepository[] = [];
  #repositoriesStatus: DashboardState["repositoriesStatus"] = "idle";
  #repositoriesProvider: ProviderId | undefined;
  #repositoriesHost: string | undefined;
  #repositoriesMessage: string | undefined;
  #repositoriesLoading = false;
  #reloadReposOnFocus = false;

  constructor(readonly context: vscode.ExtensionContext, deps: ControllerDeps = {}) {
    this.#deps = deps;
    context.subscriptions.push(this.#changed, this.#virtualDocuments);
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("rulesync-remote", this.#virtualDocuments));
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("rulesync-base", this.#virtualDocuments));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("rulesync.updateCheck")) {
        this.startPolling();
        this.publish();
      }
      for (const session of this.#sessions.values()) {
        if (event.affectsConfiguration("rulesync.sources", session.folder.uri) || event.affectsConfiguration("rulesync.projectInitialized", session.folder.uri) || event.affectsConfiguration("rulesync.optOut", session.folder.uri)) void session.initialize();
      }
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders((event) => void this.onWorkspaceFoldersChanged(event)));
    context.subscriptions.push(vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        void this.refreshConfigured("focus");
        if (this.#reloadReposOnFocus && this.#githubConnected && this.selectedProvider() === "github" && !this.selected()?.source()) {
          this.#reloadReposOnFocus = false;
          void this.loadAccessibleRepositories("github");
        }
      }
    }));
    context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => void this.initialize()));
  }

  get onDidChange() { return this.#changed.event; }

  async initialize(): Promise<void> {
    await this.reconcileFolders();
    this.startPolling();
    await this.syncAuthFlags();
    this.publish();
  }

  dispose(): void {
    for (const session of this.#sessions.values()) session.dispose();
    this.#sessions.clear();
    if (this.#timer) clearInterval(this.#timer);
  }

  async refresh(): Promise<void> {
    await this.selected()?.refresh();
  }

  async handle(command: DashboardCommand): Promise<void> {
    try {
      if (!this.trusted() && !untrustedAllowed.has(command.type)) this.assertTrusted();
      await this.dispatch(command);
    } catch (error) {
      const provider = commandProvider(command) ?? this.selectedProvider();
      if (isUnauthorized(error)) {
        if (provider === "github") {
          const token = await this.refreshAccessToken();
          if (token) { await this.dispatch(command); return; }
          await this.forgetGithubSession();
          throw new Error("GitHub sign-in expired. Connect GitHub again.");
        }
        await this.forgetGitlabSession(commandGitlabHost(command) ?? this.selected()?.gitlabBaseUrl);
        throw new Error("GitLab token expired or was revoked. Paste a new personal access token.");
      }
      throw error instanceof Error ? new Error(providerUserMessage(provider, error)) : error;
    }
  }

  private async dispatch(command: DashboardCommand): Promise<void> {
    switch (command.type) {
      case "ready": this.publish(); void this.selected()?.maybeRefresh("dashboard"); return;
      case "auth.start": await this.authenticate(); return;
      case "auth.forget": await this.forgetGithubSession(); return;
      case "github.app.create":
      case "github.app.install":
        this.#reloadReposOnFocus = true;
        await vscode.env.openExternal(vscode.Uri.parse(githubAppInstallUrl));
        return;
      case "github.app.help": await vscode.env.openExternal(vscode.Uri.parse("https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app")); return;
      case "github.repos.refresh": await this.loadAccessibleRepositories("github"); return;
      case "gitlab.host.approve": await this.approveGitlabHost(command.baseUrl); return;
      case "gitlab.pat.save": await this.saveGitlabToken(command.baseUrl, command.token); return;
      case "gitlab.pat.forget": await this.forgetGitlabSession(command.baseUrl); this.publish(); return;
      case "gitlab.pat.help": await this.openGitlabPatHelp(command.baseUrl); return;
      case "gitlab.repos.refresh": await this.loadAccessibleRepositories("gitlab"); return;
      case "settings.updateCheck": await this.saveUpdateCheck(command.settings); return;
      case "folder.select": await this.selectFolder(command.folderUri); return;
      case "workspace.source.assign": await this.assignLegacySource(command.folderUri); return;
      case "workspace.source.discard": await this.discardLegacySource(); return;
      default: break;
    }
    if (!sessionCommands.has(command.type)) return;
    const session = this.selected();
    if (!session) throw new Error("Open a local folder to use RuleSync.");
    await session.handle(command);
  }

  private publish(): void {
    this.#changed.fire(this.dashboardState());
  }

  dashboardState(): DashboardState {
    const folders = this.folderSummaries();
    const shared = {
      githubConnected: this.#githubConnected,
      gitlabConnected: this.#gitlabConnected,
      gitlabApprovedHosts: this.approvedGitlabHosts(),
      availableRepositories: this.#availableRepositories,
      repositoriesStatus: this.#repositoriesStatus,
      repositoriesProvider: this.#repositoriesProvider,
      repositoriesMessage: this.#repositoriesMessage,
      updateCheck: this.updateCheck(),
      folders,
      selectedFolderUri: this.#selectedUri,
      legacyWorkspaceSource: this.legacyWorkspaceSource()
    };
    const selected = this.selected();
    if (selected) return selected.toDashboardState(shared);
    return {
      configured: false,
      projectInitialized: false,
      hasLocalCursorConfiguration: false,
      githubConnected: this.#githubConnected,
      gitlabConnected: this.#gitlabConnected,
      gitlabApprovedHosts: shared.gitlabApprovedHosts,
      manifestStatus: "notChecked",
      trusted: this.trusted(),
      status: "unconfigured",
      statusMessage: "Open a local folder to use RuleSync.",
      items: [],
      incomingCount: 0,
      localCount: 0,
      conflictCount: 0,
      warningCount: 0,
      proposedCount: 0,
      risks: [],
      availableRepositories: this.#availableRepositories,
      repositoriesStatus: this.#repositoriesStatus,
      repositoriesProvider: this.#repositoriesProvider,
      repositoriesMessage: this.#repositoriesMessage,
      updateCheck: shared.updateCheck,
      folders
    };
  }

  private sessionHost(): FolderSessionHost {
    return {
      trusted: () => this.trusted(),
      githubToken: () => this.githubToken(),
      gitlabToken: (host) => this.gitlabToken(host),
      gitlabHostAllowed: (host) => this.gitlabHostAllowed(host),
      approvedGitlabHosts: () => this.approvedGitlabHosts(),
      createGithub: (token, signal) => this.createGithub(token, signal),
      createGitlab: (token, baseUrl, signal) => this.createGitlab(token, baseUrl, signal),
      refreshAccessToken: () => this.refreshAccessToken(),
      forgetGithubSession: () => this.forgetGithubSession(),
      forgetGitlabSession: (host) => this.forgetGitlabSession(host),
      virtualDocuments: this.#virtualDocuments,
      deps: this.#deps,
      context: this.context,
      onChange: () => this.publish(),
      selectAndOpenDashboard: (uri) => this.selectAndOpenDashboard(uri),
      updateCheck: () => this.updateCheck()
    };
  }

  private async reconcileFolders(): Promise<void> {
    const folders = eligibleFolders();
    const seen = new Set(folders.map((folder) => folderUri(folder)));
    for (const [uri, session] of this.#sessions) {
      if (seen.has(uri)) continue;
      session.dispose();
      this.#sessions.delete(uri);
    }
    for (const folder of folders) {
      const uri = folderUri(folder);
      if (!this.#sessions.has(uri)) this.#sessions.set(uri, new FolderSession(folder, this.sessionHost()));
    }
    if (folders.length === 1 && !isMultiRoot()) await migrateSingleFolderState(this.context, folders[0]!);
    const remembered = this.context.workspaceState.get<string>(selectedFolderKey);
    if (remembered && this.#sessions.has(remembered)) this.#selectedUri = remembered;
    else if (!this.#selectedUri || !this.#sessions.has(this.#selectedUri)) this.#selectedUri = folders[0] ? folderUri(folders[0]) : undefined;
    if (this.#selectedUri) await this.context.workspaceState.update(selectedFolderKey, this.#selectedUri);
    if (!this.trusted()) {
      this.#githubConnected = false;
      this.#gitlabConnected = false;
    }
    for (const folder of folders) await this.#sessions.get(folderUri(folder))?.initialize();
  }

  private async onWorkspaceFoldersChanged(event: vscode.WorkspaceFoldersChangeEvent): Promise<void> {
    for (const folder of event.removed) {
      const uri = folderUri(folder);
      this.#sessions.get(uri)?.dispose();
      this.#sessions.delete(uri);
    }
    for (const folder of event.added) {
      if (folder.uri.scheme !== "file") continue;
      const uri = folderUri(folder);
      if (this.#sessions.has(uri)) continue;
      const session = new FolderSession(folder, this.sessionHost());
      this.#sessions.set(uri, session);
      await session.initialize();
    }
    const remaining = eligibleFolders();
    if (this.#selectedUri && this.#sessions.has(this.#selectedUri)) {
      this.publish();
      return;
    }
    this.#selectedUri = remaining[0] ? folderUri(remaining[0]) : undefined;
    if (this.#selectedUri) await this.context.workspaceState.update(selectedFolderKey, this.#selectedUri);
    await this.syncAuthFlags();
    this.publish();
  }

  private selected(): FolderSession | undefined {
    return this.#selectedUri ? this.#sessions.get(this.#selectedUri) : undefined;
  }

  private folderSummaries(): DashboardFolder[] {
    return eligibleFolders().flatMap((folder) => {
      const session = this.#sessions.get(folderUri(folder));
      return session ? [session.summary()] : [];
    });
  }

  private async selectFolder(uri: string): Promise<void> {
    if (!this.#sessions.has(uri)) throw new Error("That folder is not in this workspace.");
    this.#selectedUri = uri;
    await this.context.workspaceState.update(selectedFolderKey, uri);
    this.resetRepositoriesIfNeeded(this.selectedProvider(), this.selected()?.gitlabBaseUrl);
    await this.syncAuthFlags();
    this.publish();
  }

  private async selectAndOpenDashboard(uri: string): Promise<void> {
    if (this.#sessions.has(uri)) await this.selectFolder(uri);
    await vscode.commands.executeCommand("rulesync.openDashboard");
  }

  private async assignLegacySource(uri: string): Promise<void> {
    this.assertTrusted();
    const session = this.#sessions.get(uri);
    if (!session) throw new Error("That folder is not in this workspace.");
    await assignLegacyWorkspaceSetup(this.context, session.folder);
    await this.selectFolder(uri);
    await session.initialize();
  }

  private async discardLegacySource(): Promise<void> {
    this.assertTrusted();
    const answer = await vscode.window.showWarningMessage("Discard leftover workspace RuleSync setup? No folder will be configured.", { modal: true }, "Discard");
    if (answer !== "Discard") return;
    await discardLegacyWorkspaceSetup(this.context);
    this.publish();
  }

  private legacyWorkspaceSource(): LegacyWorkspaceSource | undefined {
    if (!isMultiRoot() || !hasLegacyWorkspaceSetup()) return undefined;
    const assignment = readLegacyAssignment(this.context);
    if (assignment?.status === "assigned" || assignment?.status === "discarded") return undefined;
    const source = configuredSource(inspectWorkspaceSources() ?? []);
    return source ? { provider: source.provider, repository: source.repository } : { provider: "github", repository: "" };
  }

  private trusted(): boolean { return vscode.workspace.isTrusted; }

  private selectedProvider(): ProviderId {
    const selected = this.selected();
    return selected?.source()?.provider ?? (this.#gitlabConnected && !this.#githubConnected ? "gitlab" : "github");
  }

  private approvedGitlabHosts(): string[] {
    return this.context.globalState.get<string[]>(gitlabApprovedHostsKey) ?? [];
  }

  private gitlabHostAllowed(baseUrl?: string): boolean {
    return isGitlabHostApproved(baseUrl, this.approvedGitlabHosts());
  }

  private async githubToken(): Promise<string | undefined> { return this.context.secrets.get(tokenKey); }

  private async gitlabToken(baseUrl?: string): Promise<string | undefined> {
    const host = (() => { try { return canonicalGitlabBaseUrl(baseUrl ?? this.selected()?.gitlabBaseUrl); } catch { return this.selected()?.gitlabBaseUrl ?? "https://gitlab.com"; } })();
    if (!this.gitlabHostAllowed(host)) return undefined;
    return this.context.secrets.get(gitlabPatSecretKey(host));
  }

  private async syncAuthFlags(): Promise<void> {
    if (!this.trusted()) {
      this.#githubConnected = false;
      this.#gitlabConnected = false;
      return;
    }
    this.#githubConnected = Boolean(await this.githubToken());
    const host = this.selected()?.gitlabBaseUrl ?? "https://gitlab.com";
    this.#gitlabConnected = this.gitlabHostAllowed(host) && Boolean(await this.gitlabToken(host));
  }

  private async forgetGithubSession(): Promise<void> {
    await this.context.secrets.delete(tokenKey);
    await this.context.secrets.delete(refreshTokenKey);
    this.#githubConnected = false;
    if (this.#repositoriesProvider === "github") {
      this.#availableRepositories = [];
      this.#repositoriesStatus = "idle";
      this.#repositoriesProvider = undefined;
      this.#repositoriesHost = undefined;
      this.#repositoriesMessage = undefined;
      this.#repositoriesGeneration += 1;
    }
    for (const session of this.#sessions.values()) {
      if (session.usesProvider("github")) session.markNeedsReview("GitHub sign-in expired. Connect GitHub again.");
    }
    this.publish();
  }

  private async refreshAccessToken(): Promise<string | undefined> {
    const refreshToken = await this.context.secrets.get(refreshTokenKey);
    if (!refreshToken) return undefined;
    try {
      const refresh = this.#deps.refreshUserAccessToken ?? refreshUserAccessToken;
      const token = await refresh(bundledGithubAppClientId, refreshToken);
      await this.context.secrets.store(tokenKey, token.accessToken);
      if (token.refreshToken) await this.context.secrets.store(refreshTokenKey, token.refreshToken);
      this.#githubConnected = true;
      return token.accessToken;
    } catch { return undefined; }
  }

  private async forgetGitlabSession(baseUrl?: string): Promise<void> {
    const host = (() => { try { return canonicalGitlabBaseUrl(baseUrl ?? this.selected()?.gitlabBaseUrl); } catch { return this.selected()?.gitlabBaseUrl ?? "https://gitlab.com"; } })();
    await this.context.secrets.delete(gitlabPatSecretKey(host));
    if (this.selected()?.gitlabBaseUrl === host) this.#gitlabConnected = false;
    if (this.#repositoriesProvider === "gitlab" && this.#repositoriesHost === host) {
      this.#availableRepositories = [];
      this.#repositoriesStatus = "idle";
      this.#repositoriesProvider = undefined;
      this.#repositoriesHost = undefined;
      this.#repositoriesMessage = undefined;
      this.#repositoriesGeneration += 1;
    }
    for (const session of this.#sessions.values()) {
      if (session.usesProvider("gitlab", host)) session.markNeedsReview("Paste a GitLab personal access token to check remote rules.");
    }
  }

  private createGithub(token: string, signal?: AbortSignal): RulesProvider {
    return this.#deps.createGithub?.(token, signal) ?? new GitHubProvider(token, { signal });
  }

  private createGitlab(token: string, baseUrl: string, signal?: AbortSignal): RulesProvider {
    return this.#deps.createGitlab?.({ token, baseUrl, signal }) ?? new GitLabProvider({ token, baseUrl, signal });
  }

  private async withGithub<T>(run: (github: RulesProvider) => Promise<T>): Promise<T> {
    const token = await this.githubToken();
    if (!token) throw new Error("Sign in to GitHub to continue.");
    try { return await run(this.createGithub(token)); } catch (error) {
      if (!isUnauthorized(error)) throw error;
      const next = await this.refreshAccessToken();
      if (!next) {
        await this.forgetGithubSession();
        throw new Error("GitHub sign-in expired. Connect GitHub again.");
      }
      return run(this.createGithub(next));
    }
  }

  private async withGitlab<T>(run: (gitlab: RulesProvider) => Promise<T>, baseUrl?: string): Promise<T> {
    const host = canonicalGitlabBaseUrl(baseUrl ?? this.selected()?.gitlabBaseUrl);
    if (!this.gitlabHostAllowed(host)) throw new Error(`Approve ${host} before connecting GitLab.`);
    const token = await this.gitlabToken(host);
    if (!token) throw new Error("Connect GitLab before choosing a repository.");
    try { return await run(this.createGitlab(token, host)); } catch (error) {
      if (!isUnauthorized(error)) throw error;
      await this.forgetGitlabSession(host);
      throw new Error("GitLab token expired or was revoked. Paste a new personal access token.");
    }
  }

  private repositoriesKey(provider: ProviderId, host?: string): string {
    return provider === "gitlab" ? `gitlab:${(() => { try { return canonicalGitlabBaseUrl(host); } catch { return host ?? ""; } })()}` : "github";
  }

  private resetRepositoriesIfNeeded(provider: ProviderId, host?: string): void {
    const key = this.repositoriesKey(provider, host);
    const current = this.#repositoriesProvider ? this.repositoriesKey(this.#repositoriesProvider, this.#repositoriesHost) : undefined;
    if (current === key) return;
    this.#availableRepositories = [];
    this.#repositoriesStatus = "idle";
    this.#repositoriesMessage = undefined;
    this.#repositoriesProvider = undefined;
    this.#repositoriesHost = undefined;
    this.#repositoriesGeneration += 1;
    this.#repositoriesLoading = false;
  }

  private async loadAccessibleRepositories(providerId = this.selectedProvider()): Promise<void> {
    this.assertTrusted();
    const host = providerId === "gitlab" ? this.selected()?.gitlabBaseUrl ?? "https://gitlab.com" : undefined;
    if (providerId === "gitlab" && !this.gitlabHostAllowed(host)) throw new Error(`Approve ${host} before listing GitLab projects.`);
    const token = providerId === "gitlab" ? await this.gitlabToken(host) : await this.githubToken();
    if (!token) return;
    const key = this.repositoriesKey(providerId, host);
    if (this.#repositoriesLoading && this.#repositoriesProvider === providerId && this.repositoriesKey(providerId, this.#repositoriesHost) === key) return;
    const generation = ++this.#repositoriesGeneration;
    this.#repositoriesLoading = true;
    this.#repositoriesProvider = providerId;
    this.#repositoriesHost = host;
    this.#availableRepositories = [];
    this.#repositoriesStatus = "loading";
    this.#repositoriesMessage = undefined;
    this.publish();
    try {
      const repos = providerId === "gitlab" ? await this.withGitlab((provider) => provider.listAccessibleRepositories(), host) : await this.withGithub((provider) => provider.listAccessibleRepositories());
      if (generation !== this.#repositoriesGeneration) return;
      this.#availableRepositories = repos;
      this.#repositoriesStatus = "ready";
    } catch (error) {
      if (generation !== this.#repositoriesGeneration) return;
      this.#availableRepositories = [];
      this.#repositoriesStatus = "error";
      this.#repositoriesMessage = error instanceof Error ? error.message : `Could not load repositories from ${providerId === "gitlab" ? "GitLab" : "GitHub"}.`;
    } finally {
      if (generation === this.#repositoriesGeneration) this.#repositoriesLoading = false;
      this.publish();
    }
  }

  private assertTrusted(): void {
    if (!this.trusted()) throw new Error("Trust this workspace before RuleSync reads or writes local files.");
  }

  private startPolling(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (!this.trusted()) return;
    const settings = this.updateCheck();
    if (settings.mode !== "timed" && settings.mode !== "both") return;
    this.#timer = setInterval(() => void this.refreshConfigured("timer"), 60_000);
  }

  private async refreshConfigured(trigger: UpdateCheckTrigger): Promise<void> {
    for (const session of this.#sessions.values()) {
      if (session.source()) await session.maybeRefresh(trigger);
    }
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
    if (typeof legacy === "number") return { ...defaultUpdateCheck, mode: "timed", interval: legacy <= 90 ? "hourly" : "daily" };
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

  private async authenticate(): Promise<void> {
    this.assertTrusted();
    const requestCode = this.#deps.requestDeviceCode ?? requestDeviceCode;
    const poll = this.#deps.pollDeviceToken ?? pollDeviceToken;
    const selected = this.selected();
    try {
      const device = await requestCode(bundledGithubAppClientId);
      await vscode.env.openExternal(vscode.Uri.parse(device.verificationUri));
      void vscode.window.showInformationMessage(`Enter GitHub code ${device.userCode} to connect RuleSync.`);
      selected?.setStatus("checking", `Waiting for GitHub authorization: ${device.userCode}`);
      this.publish();
      const deadline = Date.now() + device.expiresIn * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, device.interval * 1000));
        const token = await poll(bundledGithubAppClientId, device.deviceCode);
        if (!token) continue;
        await this.context.secrets.store(tokenKey, token.accessToken);
        if (token.refreshToken) await this.context.secrets.store(refreshTokenKey, token.refreshToken);
        if (selected?.source()?.provider === "gitlab") await selected.clearConfiguredSource();
        this.#githubConnected = true;
        selected?.setStatus("needsReview", "GitHub connected. Choose a rules repository.");
        await this.loadAccessibleRepositories("github");
        for (const session of this.#sessions.values()) {
          if (session.usesProvider("github")) await session.refresh();
        }
        if (!selected?.source()) this.publish();
        return;
      }
      throw new Error("GitHub authorization timed out.");
    } catch (error) {
      selected?.setStatus("error", providerUserMessage("github", error));
      this.publish();
    }
  }

  private async approveGitlabHost(baseUrl: string): Promise<void> {
    this.assertTrusted();
    const host = canonicalGitlabBaseUrl(baseUrl);
    if (host !== "https://gitlab.com") {
      const answer = await vscode.window.showWarningMessage(`Allow RuleSync to use GitLab at ${host}? Tokens for this host stay in this editor and are never sent to another host.`, { modal: true }, "Allow this host");
      if (answer !== "Allow this host") return;
      const next = [...new Set([...this.approvedGitlabHosts(), host])];
      await this.context.globalState.update(gitlabApprovedHostsKey, next);
    }
    const selected = this.selected();
    selected?.rememberGitlabHost(host);
    if (selected) await this.context.workspaceState.update(folderGitlabBaseUrlKey(selected.uri), host);
    await this.syncAuthFlags();
    for (const session of this.#sessions.values()) {
      if (session.usesProvider("gitlab", host)) await session.initialize();
    }
    if (this.#gitlabConnected && selected?.source()?.provider === "gitlab") return;
    selected?.setStatus("needsReview", this.#gitlabConnected ? "GitLab connected. Choose a rules project." : "Paste a GitLab personal access token to check remote rules.");
    this.publish();
  }

  private async openGitlabPatHelp(baseUrl?: string): Promise<void> {
    this.assertTrusted();
    const host = canonicalGitlabBaseUrl(baseUrl);
    if (!this.gitlabHostAllowed(host)) throw new Error(`Approve ${host} before opening GitLab token help.`);
    await vscode.env.openExternal(vscode.Uri.parse(gitlabPatCreateUrl(host)));
  }

  private async saveGitlabToken(baseUrl: string | undefined, token: string): Promise<void> {
    this.assertTrusted();
    const host = canonicalGitlabBaseUrl(baseUrl);
    if (!this.gitlabHostAllowed(host)) throw new Error(`Approve ${host} before saving a GitLab token.`);
    const trimmed = token.trim();
    if (!trimmed) throw new Error("A GitLab personal access token is required.");
    const gitlab = this.createGitlab(trimmed, host);
    await gitlab.authenticatedLogin();
    if ("assertApiScope" in gitlab && typeof gitlab.assertApiScope === "function") await gitlab.assertApiScope();
    await this.context.secrets.store(gitlabPatSecretKey(host), trimmed);
    const selected = this.selected();
    selected?.rememberGitlabHost(host);
    if (selected) await this.context.workspaceState.update(folderGitlabBaseUrlKey(selected.uri), host);
    if (selected?.source()?.provider === "github") await selected.clearConfiguredSource();
    this.#gitlabConnected = true;
    selected?.setStatus("needsReview", "GitLab connected. Choose a rules project.");
    this.resetRepositoriesIfNeeded("gitlab", host);
    await this.loadAccessibleRepositories("gitlab");
    for (const session of this.#sessions.values()) {
      if (session.usesProvider("gitlab", host)) await session.refresh();
    }
    if (!selected?.source() || selected.source()?.provider !== "gitlab") this.publish();
  }
}
