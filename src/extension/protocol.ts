import type { ContentType, DashboardState, ProviderId, SourceSpec, UpdateCheckSettings } from "@rulesync/core";

export type DashboardCommand =
  | { type: "ready" }
  | { type: "auth.start" }
  | { type: "auth.forget" }
  | { type: "github.app.create" }
  | { type: "github.app.install" }
  | { type: "github.app.help" }
  | { type: "workspace.initialize" }
  | { type: "manifest.initialize" }
  | { type: "source.save"; source: SourceSpec }
  | { type: "github.repos.refresh" }
  | { type: "gitlab.host.approve"; baseUrl: string }
  | { type: "gitlab.pat.save"; baseUrl?: string; token: string }
  | { type: "gitlab.pat.forget"; baseUrl?: string }
  | { type: "gitlab.pat.help"; baseUrl?: string }
  | { type: "gitlab.repos.refresh" }
  | { type: "sync.refresh" }
  | { type: "content.open"; path: string }
  | { type: "content.diff"; path: string; comparison: "remote" | "base" }
  | { type: "content.create"; request: { type: ContentType; name: string; description?: string; ruleMode?: "always" | "auto" | "agent" | "manual"; globs?: string; relativePath?: string; localOnly?: boolean } }
  | { type: "content.disable"; path: string }
  | { type: "content.enable"; path: string }
  | { type: "content.localOnly"; path: string; enabled: boolean }
  | { type: "content.rename"; path: string }
  | { type: "content.delete"; path: string }
  | { type: "content.revert"; path: string }
  | { type: "conflict.resolve"; path: string; resolution: "local" | "remote" }
  | { type: "remote.apply"; path: string }
  | { type: "remote.applyAll" }
  | { type: "remote.restore" }
  | { type: "risks.accept" }
  | { type: "risk.accept"; path: string; code: string }
  | { type: "proposal.publish"; message: string }
  | { type: "proposal.openCompare" }
  | { type: "review.open" }
  | { type: "repository.open" }
  | { type: "settings.updateCheck"; settings: UpdateCheckSettings }
  | { type: "source.disconnect" }
  | { type: "folder.select"; folderUri: string }
  | { type: "workspace.source.assign"; folderUri: string }
  | { type: "workspace.source.discard" };

export type DashboardEvent =
  | { type: "state.replace"; state: DashboardState }
  | { type: "operation.progress"; message: string }
  | { type: "operation.done"; command: string }
  | { type: "operation.error"; message: string }
  | { type: "auth.device"; code: string; url: string; expiresAt: string };

export function commandProvider(command: DashboardCommand): ProviderId | undefined {
  if (command.type.startsWith("gitlab.")) return "gitlab";
  if (command.type.startsWith("auth.") || command.type.startsWith("github.")) return "github";
  if (command.type === "source.save") return command.source.provider;
  return undefined;
}

export function commandGitlabHost(command: DashboardCommand): string | undefined {
  if (command.type === "gitlab.host.approve" || command.type === "gitlab.pat.save" || command.type === "gitlab.pat.forget" || command.type === "gitlab.pat.help") return command.baseUrl;
  if (command.type === "source.save" && command.source.provider === "gitlab") return command.source.baseUrl;
  return undefined;
}
