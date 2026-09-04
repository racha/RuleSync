import { canDisableManagedPath, canonicalGitlabBaseUrl, gitlabHostSessionReady, highRiskCodes, isGitlabHostApproved, isHighRisk, preferredSetupProvider, proposalCommitMessage } from "@rulesync/core";

type SetupHost = "github" | "gitlab";

interface SetupSource {
  provider: SetupHost;
  repository: string;
  baseUrl?: string;
}

interface SetupSession {
  source?: SetupSource;
  configured?: boolean;
  githubConnected: boolean;
  gitlabConnected: boolean;
  statusMessage?: string;
}

export const defaultSetupProvider = preferredSetupProvider;
export { gitlabHostSessionReady, isGitlabHostApproved, isHighRisk, proposalCommitMessage };

export function sourceMatchesSetup(source: SetupSource | undefined, setupProvider: SetupHost, selectedHost?: string): boolean {
  if (source?.provider !== setupProvider) return false;
  if (setupProvider !== "gitlab" || selectedHost === undefined) return true;
  if (!selectedHost.trim()) return false;
  try { return canonicalGitlabBaseUrl(source.baseUrl) === canonicalGitlabBaseUrl(selectedHost); } catch { return false; }
}

export function setupGitlabKind(source?: SetupSource): "cloud" | "self" {
  if (source?.provider !== "gitlab") return "cloud";
  try { return canonicalGitlabBaseUrl(source.baseUrl) === "https://gitlab.com" ? "cloud" : "self"; } catch { return "self"; }
}

export function recoveredGitlabUrl(source?: SetupSource): string {
  if (source?.provider !== "gitlab") return "";
  try {
    const host = canonicalGitlabBaseUrl(source.baseUrl);
    return host === "https://gitlab.com" ? "" : host;
  } catch { return ""; }
}

export function connectSetupCopy(input: { providerReady: boolean; setupProvider: SetupHost; gitlabKind: "cloud" | "self"; hostApproved: boolean; savedHost?: string; hostLabel: "GitHub" | "GitLab"; configured: boolean }): string {
  const { providerReady, setupProvider, gitlabKind, hostApproved, savedHost, hostLabel, configured } = input;
  if (providerReady) return `${hostLabel} is connected securely for this folder.`;
  if (setupProvider === "github") return configured ? "Your GitHub session expired. Sign in again — RuleSync will keep this repository." : "The GitHub App can already be installed. Sign in here so this editor can list and sync that repository.";
  if (gitlabKind === "self" && !hostApproved) return savedHost ? `Confirm ${savedHost} before pasting a token. RuleSync will not send that token to any other host.` : "Enter the GitLab HTTPS URL, confirm that exact host, then paste a token.";
  return "Paste a personal access token. HTTPS only, using certificates your system already trusts.";
}

export function repositorySetupCopy(input: { source?: SetupSource; setupProvider: SetupHost; selectedHost?: string; hostLabel: "GitHub" | "GitLab"; providerReady: boolean }): { ready: boolean; description: string } {
  const { source, setupProvider, selectedHost, hostLabel, providerReady } = input;
  const matches = sourceMatchesSetup(source, setupProvider, selectedHost);
  if (matches && providerReady && source) return { ready: true, description: `${source.repository} is connected to this project.` };
  if (source && source.provider !== setupProvider) return { ready: false, description: `This folder still has ${source.repository} on ${source.provider === "gitlab" ? "GitLab" : "GitHub"}. Pick a ${setupProvider === "gitlab" ? "GitLab project" : "GitHub repository"} to replace it.` };
  if (source?.provider === setupProvider) return { ready: false, description: `${source.repository} is saved in this folder. Connect ${hostLabel} first.` };
  if (setupProvider === "gitlab") return { ready: false, description: "Pick one GitLab project. This folder can use GitHub or GitLab, not both." };
  return { ready: false, description: "Pick one GitHub repository. This folder can use GitHub or GitLab, not both." };
}

export function visibleSetupRepos<T>(input: { setupProvider: SetupHost; repositoriesProvider?: SetupHost; repositories: readonly T[] }): readonly T[] {
  const { setupProvider, repositoriesProvider, repositories } = input;
  return repositoriesProvider === setupProvider ? repositories : [];
}

export function setupStatusNotice(state: SetupSession, setupProvider: SetupHost, providerReady: boolean): string | undefined {
  if (providerReady) return undefined;
  const { configured, statusMessage, source } = state;
  if (setupProvider === "gitlab") return configured && source?.provider === "gitlab" && statusMessage && /token|expired|revoked|Paste a GitLab|Approve /i.test(statusMessage) ? statusMessage : "Paste a GitLab personal access token to check remote rules.";
  if (statusMessage && /Waiting for GitHub|GitHub authorization/i.test(statusMessage)) return statusMessage;
  if (!configured) return undefined;
  return statusMessage && !statusMessage.includes("GitLab") ? statusMessage : "Sign in to GitHub to check remote rules.";
}

export function firstUseGitlabUrl(): string {
  return "";
}

export function emptyRepositoryCopy(input: { repository?: string; branch?: string; host: "GitHub" | "GitLab" }): { title: string; description: string } {
  const repository = input.repository ?? "This repository";
  const branch = input.branch ?? "main";
  return {
    title: `${repository} has no ${branch} branch.`,
    description: `Create ${branch} on ${input.host} for ${repository}, then check again. RuleSync never writes the default branch.`
  };
}

export function splitRisks<T extends { code: string }>(risks: readonly T[]): { high: T[]; warnings: T[] } {
  return { high: risks.filter((risk) => (highRiskCodes as readonly string[]).includes(risk.code)), warnings: risks.filter((risk) => !(highRiskCodes as readonly string[]).includes(risk.code) && risk.code !== "large") };
}

export function hostIsApproved(baseUrl: string | undefined, approved: readonly string[]): boolean {
  if (!baseUrl?.trim()) return false;
  try { return isGitlabHostApproved(canonicalGitlabBaseUrl(baseUrl), approved); } catch { return false; }
}

const hostActions = new Set(["auth.start", "auth.forget", "workspace.initialize", "workspace.source.assign", "source.save", "source.disconnect", "github.repos.refresh", "gitlab.host.approve", "gitlab.pat.save", "gitlab.pat.forget", "gitlab.repos.refresh", "sync.refresh", "content.create", "content.localOnly", "content.revert", "conflict.resolve", "remote.apply", "remote.applyAll", "remote.restore", "risks.accept", "risk.accept", "proposal.publish", "proposal.openCompare", "review.open"]);

export function awaitsHost(type: string): boolean { return hostActions.has(type); }

export function legacyWorkspaceNotice(source: { provider: "github" | "gitlab"; repository: string }, folderName: string): string {
  const summary = source.repository ? `${source.provider === "gitlab" ? "GitLab" : "GitHub"} ${source.repository}` : "RuleSync workspace settings";
  return `This workspace file still has leftover ${summary}. Assign it to ${folderName} or discard it.`;
}

export function folderSwitchReset(): { creating: false; customProposal: false; section: "overview" } {
  return { creating: false, customProposal: false, section: "overview" };
}

export function canToggleLocalDisable({ path, status, kind }: { path: string; status: string; kind?: string }): boolean {
  if (status === "optedOut" || status === "local" && kind === "deleted" || status === "incoming" && kind === "added") return false;
  return canDisableManagedPath(path);
}

export interface MenuItemInput {
  path: string;
  status: string;
  kind?: string;
  disabled?: boolean;
  localOnly?: boolean;
  inWorkspace?: boolean;
}

export interface ItemMenuAction {
  label: string;
  action: { type: string; [key: string]: unknown };
  actionKey?: string;
  danger?: boolean;
}

export type ItemMenuEntry = ItemMenuAction | { separator: true };

export function itemMenuEntries(item: MenuItemInput, conflict = false): ItemMenuEntry[] {
  const { path, status, kind, disabled, localOnly, inWorkspace } = item;
  const removed = kind === "deleted";
  const groups: ItemMenuAction[][] = [];
  if (localOnly) groups.push([{ label: "Track with RuleSync", action: { type: "content.localOnly", path, enabled: false } }]);
  else {
    groups.push([{ label: "Compare", action: { type: "content.diff", path, comparison: status === "incoming" ? "remote" : "base" } }]);
    const sync: ItemMenuAction[] = [];
    if (conflict) {
      sync.push({ label: "Keep local", action: { type: "conflict.resolve", path, resolution: "local" }, actionKey: `conflict.resolve:${path}:local` });
      sync.push({ label: "Use remote", action: { type: "conflict.resolve", path, resolution: "remote" }, actionKey: `conflict.resolve:${path}:remote` });
    }
    if (status === "incoming") sync.push({ label: removed ? "Apply deletion" : "Pull", action: { type: "remote.apply", path }, actionKey: `remote.apply:${path}`, danger: removed });
    if (status === "local") sync.push({ label: removed ? "Restore" : "Revert", action: { type: "content.revert", path }, actionKey: `content.revert:${path}` });
    if (sync.length) groups.push(sync);
    if (inWorkspace && !removed) groups.push([{ label: "Make local only", action: { type: "content.localOnly", path, enabled: true } }]);
  }
  if (canToggleLocalDisable({ path, status, kind })) groups.push([{ label: disabled ? "Enable" : "Disable", action: { type: disabled ? "content.enable" : "content.disable", path } }]);
  if (!removed) groups.push([{ label: "Rename", action: { type: "content.rename", path } }, { label: "Delete", action: { type: "content.delete", path }, danger: true }]);
  return groups.flatMap((group, index) => index ? [{ separator: true as const }, ...group] : group);
}

export function matchesBusy(current: string | undefined, command?: string): boolean {
  return Boolean(current && command && (current === command || current.startsWith(`${command}:`)));
}
