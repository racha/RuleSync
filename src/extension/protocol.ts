import type { ContentType, DashboardState, SourceSpec, UpdateCheckSettings } from "@rulesync/core";

export type DashboardCommand =
  | { type: "ready" }
  | { type: "auth.start" }
  | { type: "github.app.create" }
  | { type: "github.app.install" }
  | { type: "github.app.help" }
  | { type: "workspace.initialize" }
  | { type: "manifest.initialize" }
  | { type: "github.clientId.save"; clientId: string }
  | { type: "source.save"; source: SourceSpec }
  | { type: "github.repos.refresh" }
  | { type: "sync.refresh" }
  | { type: "content.open"; path: string }
  | { type: "content.diff"; path: string; comparison: "remote" | "base" }
  | { type: "content.create"; request: { type: ContentType; name: string; description?: string; ruleMode?: "always" | "auto" | "agent" | "manual"; globs?: string; relativePath?: string } }
  | { type: "content.rename"; path: string }
  | { type: "content.delete"; path: string }
  | { type: "content.revert"; path: string }
  | { type: "conflict.resolve"; path: string; resolution: "local" | "remote" }
  | { type: "remote.apply"; path: string }
  | { type: "remote.applyAll" }
  | { type: "risks.accept" }
  | { type: "proposal.publish"; message: string }
  | { type: "proposal.openCompare" }
  | { type: "settings.open" }
  | { type: "settings.updateCheck"; settings: UpdateCheckSettings }
  | { type: "source.disconnect" };

export type DashboardEvent =
  | { type: "state.replace"; state: DashboardState }
  | { type: "operation.progress"; message: string }
  | { type: "operation.error"; message: string }
  | { type: "auth.device"; code: string; url: string; expiresAt: string };
