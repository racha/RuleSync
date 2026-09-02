import { z } from "zod";

const githubRepository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const gitlabRepository = z.string().regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/);

export const sourceSaveSchema = z.discriminatedUnion("provider", [
  z.object({ id: z.string().min(1), provider: z.literal("github"), repository: githubRepository, ref: z.string().optional(), profile: z.string().min(1), enabled: z.boolean().optional() }),
  z.object({ id: z.string().min(1), provider: z.literal("gitlab"), baseUrl: z.string().min(1).max(253).optional(), repository: gitlabRepository, ref: z.string().optional(), profile: z.string().min(1), enabled: z.boolean().optional() })
]);

export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("auth.start") }),
  z.object({ type: z.literal("auth.forget") }),
  z.object({ type: z.literal("github.app.create") }),
  z.object({ type: z.literal("github.app.install") }),
  z.object({ type: z.literal("github.app.help") }),
  z.object({ type: z.literal("workspace.initialize") }),
  z.object({ type: z.literal("manifest.initialize") }),
  z.object({ type: z.literal("github.repos.refresh") }),
  z.object({ type: z.literal("gitlab.host.approve"), baseUrl: z.string().min(1).max(253) }),
  z.object({ type: z.literal("gitlab.pat.save"), baseUrl: z.string().max(253).optional(), token: z.string().trim().min(1).max(2048) }),
  z.object({ type: z.literal("gitlab.pat.forget"), baseUrl: z.string().max(253).optional() }),
  z.object({ type: z.literal("gitlab.pat.help"), baseUrl: z.string().max(253).optional() }),
  z.object({ type: z.literal("gitlab.repos.refresh") }),
  z.object({ type: z.literal("sync.refresh") }),
  z.object({ type: z.literal("content.open"), path: z.string().min(1) }),
  z.object({ type: z.literal("content.diff"), path: z.string().min(1), comparison: z.enum(["remote", "base"]) }),
  z.object({ type: z.literal("content.disable"), path: z.string().min(1) }),
  z.object({ type: z.literal("content.enable"), path: z.string().min(1) }),
  z.object({ type: z.literal("content.localOnly"), path: z.string().min(1), enabled: z.boolean() }),
  z.object({ type: z.literal("content.rename"), path: z.string().min(1) }),
  z.object({ type: z.literal("content.delete"), path: z.string().min(1) }),
  z.object({ type: z.literal("content.revert"), path: z.string().min(1) }),
  z.object({ type: z.literal("conflict.resolve"), path: z.string().min(1), resolution: z.enum(["local", "remote"]) }),
  z.object({ type: z.literal("remote.apply"), path: z.string().min(1) }),
  z.object({ type: z.literal("remote.applyAll") }),
  z.object({ type: z.literal("remote.restore") }),
  z.object({ type: z.literal("risks.accept") }),
  z.object({ type: z.literal("risk.accept"), path: z.string().min(1), code: z.enum(["secret", "executable", "hook", "mcp", "binary"]) }),
  z.object({ type: z.literal("proposal.publish"), message: z.string().max(300) }),
  z.object({ type: z.literal("proposal.openCompare") }),
  z.object({ type: z.literal("settings.updateCheck"), settings: z.object({ mode: z.enum(["off", "timed", "events", "both"]), interval: z.enum(["hourly", "daily", "weekly"]), onStart: z.boolean(), onFocus: z.boolean(), onDashboardOpen: z.boolean() }) }),
  z.object({ type: z.literal("source.disconnect") }),
  z.object({ type: z.literal("folder.select"), folderUri: z.string().min(1) }),
  z.object({ type: z.literal("workspace.source.assign"), folderUri: z.string().min(1) }),
  z.object({ type: z.literal("workspace.source.discard") }),
  z.object({ type: z.literal("source.save"), source: sourceSaveSchema }),
  z.object({ type: z.literal("content.create"), request: z.object({ type: z.enum(["rule", "hook", "skill", "agent", "command", "mcp", "configuration", "other"]), name: z.string().min(1).max(100), description: z.string().max(500).optional(), ruleMode: z.enum(["always", "auto", "agent", "manual"]).optional(), globs: z.string().max(200).optional(), relativePath: z.string().max(300).optional(), localOnly: z.boolean().optional() }) })
]);
