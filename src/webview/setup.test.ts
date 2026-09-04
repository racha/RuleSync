import { describe, expect, it } from "vitest";
import { awaitsHost, canToggleLocalDisable, connectSetupCopy, defaultSetupProvider, emptyRepositoryCopy, firstUseGitlabUrl, folderSwitchReset, hostIsApproved, itemMenuEntries, legacyWorkspaceNotice, matchesBusy, recoveredGitlabUrl, repositorySetupCopy, setupGitlabKind, setupStatusNotice, sourceMatchesSetup, splitRisks, visibleSetupRepos } from "./setup.js";

const githubSource = { provider: "github" as const, repository: "racha/cursor-rules" };
const gitlabSource = { provider: "gitlab" as const, repository: "group/project" };
const selfSource = { provider: "gitlab" as const, repository: "inveon/cursor-rules", baseUrl: "https://gitlab.inveon.dev" };

describe("defaultSetupProvider", () => {
  it("stays on an expired GitHub source until GitLab is the live session", () => {
    expect(defaultSetupProvider({ source: githubSource, githubConnected: false, gitlabConnected: false })).toBe("github");
    expect(defaultSetupProvider({ source: githubSource, githubConnected: true, gitlabConnected: true })).toBe("github");
    expect(defaultSetupProvider({ source: githubSource, githubConnected: false, gitlabConnected: true })).toBe("gitlab");
  });

  it("keeps a live GitLab source and otherwise follows the only connected host", () => {
    expect(defaultSetupProvider({ source: gitlabSource, githubConnected: true, gitlabConnected: true })).toBe("gitlab");
    expect(defaultSetupProvider({ githubConnected: false, gitlabConnected: true })).toBe("gitlab");
    expect(defaultSetupProvider({ githubConnected: true, gitlabConnected: false })).toBe("github");
    expect(defaultSetupProvider({ githubConnected: true, gitlabConnected: true })).toBe("gitlab");
  });
});

describe("sourceMatchesSetup", () => {
  it("does not treat a GitHub repository as the GitLab project step", () => {
    expect(sourceMatchesSetup(githubSource, "gitlab")).toBe(false);
    expect(sourceMatchesSetup(githubSource, "github")).toBe(true);
    expect(sourceMatchesSetup(undefined, "gitlab")).toBe(false);
  });

  it("does not treat a custom-host source as connected to GitLab.com or an empty self-hosted URL", () => {
    expect(sourceMatchesSetup(selfSource, "gitlab", "https://gitlab.com")).toBe(false);
    expect(sourceMatchesSetup(selfSource, "gitlab", "")).toBe(false);
    expect(sourceMatchesSetup(selfSource, "gitlab", "https://gitlab.inveon.dev")).toBe(true);
  });
});

describe("setupStatusNotice", () => {
  it("does not keep a GitHub sign-in banner after the picker moves to GitLab", () => {
    expect(setupStatusNotice({ source: githubSource, configured: true, githubConnected: false, gitlabConnected: false, statusMessage: "Sign in to GitHub to check remote rules." }, "gitlab", false)).toBe("Paste a GitLab personal access token to check remote rules.");
    expect(setupStatusNotice({ source: githubSource, configured: true, githubConnected: false, gitlabConnected: false, statusMessage: "Sign in to GitHub to check remote rules." }, "github", false)).toBe("Sign in to GitHub to check remote rules.");
    expect(setupStatusNotice({ source: githubSource, configured: true, githubConnected: false, gitlabConnected: true }, "gitlab", true)).toBeUndefined();
    expect(setupStatusNotice({ source: gitlabSource, configured: true, githubConnected: false, gitlabConnected: false, statusMessage: "Everything is synchronized." }, "gitlab", false)).toBe("Paste a GitLab personal access token to check remote rules.");
    expect(setupStatusNotice({ configured: false, githubConnected: false, gitlabConnected: false, statusMessage: "Waiting for GitHub authorization: ABCD-1234" }, "github", false)).toBe("Waiting for GitHub authorization: ABCD-1234");
  });

  it("does not treat GitHub App install as a finished connection", () => {
    expect(connectSetupCopy({ providerReady: false, setupProvider: "github", gitlabKind: "cloud", hostApproved: true, hostLabel: "GitHub", configured: false })).toContain("Sign in here");
  });
});

describe("empty repository and risk helpers", () => {
  it("names the exact project and default branch", () => {
    expect(emptyRepositoryCopy({ repository: "group/project", branch: "main", host: "GitLab" })).toEqual({
      title: "group/project has no main branch.",
      description: "Create main on GitLab for group/project, then check again. RuleSync never writes the default branch."
    });
  });

  it("never prefills a first-use GitLab host and keeps high-risk findings out of bulk accept", () => {
    expect(firstUseGitlabUrl()).toBe("");
    expect(hostIsApproved("https://gitlab.example.com", [])).toBe(false);
    expect(hostIsApproved("https://gitlab.com", [])).toBe(true);
    expect(hostIsApproved("", [])).toBe(false);
    expect(splitRisks([{ code: "hook" }, { code: "large" }, { code: "secret" }])).toEqual({ high: [{ code: "hook" }, { code: "secret" }], warnings: [] });
  });

  it("recovers a saved custom host without marking the repository connected", () => {
    expect(setupGitlabKind(selfSource)).toBe("self");
    expect(recoveredGitlabUrl(selfSource)).toBe("https://gitlab.inveon.dev");
    expect(setupGitlabKind(gitlabSource)).toBe("cloud");
    expect(recoveredGitlabUrl(gitlabSource)).toBe("");
    expect(connectSetupCopy({ providerReady: false, setupProvider: "gitlab", gitlabKind: "self", hostApproved: false, savedHost: "https://gitlab.inveon.dev", hostLabel: "GitLab", configured: true })).toContain("Confirm https://gitlab.inveon.dev");
    expect(repositorySetupCopy({ source: selfSource, setupProvider: "gitlab", selectedHost: "https://gitlab.inveon.dev", hostLabel: "GitLab", providerReady: false })).toEqual({ ready: false, description: "inveon/cursor-rules is saved in this folder. Connect GitLab first." });
    expect(repositorySetupCopy({ source: selfSource, setupProvider: "gitlab", selectedHost: "https://gitlab.inveon.dev", hostLabel: "GitLab", providerReady: true }).ready).toBe(true);
    expect(repositorySetupCopy({ setupProvider: "github", hostLabel: "GitHub", providerReady: false }).description).toContain("This folder can use GitHub or GitLab, not both");
    expect(connectSetupCopy({ providerReady: true, setupProvider: "github", gitlabKind: "cloud", hostApproved: true, hostLabel: "GitHub", configured: true })).toContain("this folder");
  });
});

describe("awaitsHost", () => {
  it("tracks host commands and ignores local navigation", () => {
    expect(awaitsHost("sync.refresh")).toBe(true);
    expect(awaitsHost("auth.forget")).toBe(true);
    expect(awaitsHost("remote.restore")).toBe(true);
    expect(awaitsHost("content.localOnly")).toBe(true);
    expect(awaitsHost("proposal.openCompare")).toBe(true);
    expect(awaitsHost("review.open")).toBe(true);
    expect(awaitsHost("repository.open")).toBe(false);
    expect(awaitsHost("proposal.publish")).toBe(true);
    expect(awaitsHost("ready")).toBe(false);
    expect(awaitsHost("content.open")).toBe(false);
    expect(awaitsHost("content.rename")).toBe(false);
    expect(awaitsHost("content.delete")).toBe(false);
    expect(awaitsHost("content.disable")).toBe(false);
    expect(awaitsHost("content.enable")).toBe(false);
    expect(awaitsHost("folder.select")).toBe(false);
    expect(awaitsHost("workspace.source.assign")).toBe(true);
    expect(awaitsHost("workspace.source.discard")).toBe(false);
    expect(legacyWorkspaceNotice({ provider: "github", repository: "acme/rules" }, "alpha")).toBe("This workspace file still has leftover GitHub acme/rules. Assign it to alpha or discard it.");
    expect(legacyWorkspaceNotice({ provider: "github", repository: "" }, "this folder")).toContain("RuleSync workspace settings");
    expect(folderSwitchReset()).toEqual({ creating: false, customProposal: false, section: "overview" });
  });

  it("hides disable for opted-out, missing, and hook-script files", () => {
    expect(canToggleLocalDisable({ path: ".cursor/rules/foo.mdc", status: "synced" })).toBe(true);
    expect(canToggleLocalDisable({ path: ".cursor/hooks.json", status: "synced" })).toBe(true);
    expect(canToggleLocalDisable({ path: ".cursor/rules/foo.mdc", status: "optedOut" })).toBe(false);
    expect(canToggleLocalDisable({ path: ".cursor/rules/foo.mdc", status: "local", kind: "deleted" })).toBe(false);
    expect(canToggleLocalDisable({ path: ".cursor/rules/foo.mdc", status: "incoming", kind: "added" })).toBe(false);
    expect(canToggleLocalDisable({ path: ".cursor/hooks/record.sh", status: "synced" })).toBe(false);
  });

  it("builds local-only menus without compare or sync actions", () => {
    const labels = (entries: ReturnType<typeof itemMenuEntries>) => entries.flatMap((entry) => "label" in entry ? [entry.label] : []);
    expect(labels(itemMenuEntries({ path: ".cursor/rules/foo.mdc", status: "synced", localOnly: true, inWorkspace: true }))).toEqual(["Track with RuleSync", "Disable", "Rename", "Delete"]);
    expect(labels(itemMenuEntries({ path: ".cursor/rules/foo.mdc", status: "synced", inWorkspace: true }))).toEqual(["Compare", "Make local only", "Disable", "Rename", "Delete"]);
    expect(labels(itemMenuEntries({ path: ".cursor/rules/foo.mdc", status: "incoming", kind: "added" }))).toEqual(["Compare", "Pull", "Rename", "Delete"]);
    expect(labels(itemMenuEntries({ path: ".cursor/rules/foo.mdc", status: "local", kind: "modified", inWorkspace: true }))).toContain("Revert");
  });

  it("clears a matching busy key when the host command finishes", () => {
    expect(matchesBusy("remote.apply:.cursor/rules/a.mdc", "remote.apply")).toBe(true);
    expect(matchesBusy("proposal.openCompare", "proposal.openCompare")).toBe(true);
    expect(matchesBusy("proposal.publish", "sync.refresh")).toBe(false);
    expect(matchesBusy(undefined, "sync.refresh")).toBe(false);
  });

  it("hides the other host’s repository list", () => {
    const gitlab = [{ repository: "group/project" }];
    expect(visibleSetupRepos({ setupProvider: "github", repositoriesProvider: "gitlab", repositories: gitlab })).toEqual([]);
    expect(visibleSetupRepos({ setupProvider: "github", repositoriesProvider: "github", repositories: [{ repository: "racha/cursor-rules" }] })).toEqual([{ repository: "racha/cursor-rules" }]);
  });
});
