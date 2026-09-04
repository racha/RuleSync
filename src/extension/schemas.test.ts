import { describe, expect, it } from "vitest";

import { commandSchema, sourceSaveSchema } from "./schemas.js";
import { commandGitlabHost, commandProvider } from "./protocol.js";

describe("sourceSaveSchema", () => {
  it("keeps GitHub to two path segments", () => {
    expect(sourceSaveSchema.safeParse({ id: "team", provider: "github", repository: "acme/rules", profile: "cursor-project" }).success).toBe(true);
    expect(sourceSaveSchema.safeParse({ id: "team", provider: "github", repository: "group/sub/project", profile: "cursor-project" }).success).toBe(false);
  });

  it("accepts nested GitLab paths and optional base URLs", () => {
    expect(sourceSaveSchema.safeParse({ id: "team", provider: "gitlab", repository: "group/project", profile: "cursor-project" }).success).toBe(true);
    expect(sourceSaveSchema.safeParse({ id: "team", provider: "gitlab", baseUrl: "https://gitlab.example.com", repository: "group/sub/project", profile: "cursor-project" }).success).toBe(true);
    expect(sourceSaveSchema.safeParse({ id: "team", provider: "gitlab", repository: "solo", profile: "cursor-project" }).success).toBe(false);
  });
});

describe("commandSchema", () => {
  it("rejects a workspace GitHub client-ID override command", () => {
    expect(commandSchema.safeParse({ type: "github.clientId.save", clientId: "Iv23attacker" }).success).toBe(false);
  });

  it("accepts host approval and a single high-risk acknowledgement", () => {
    expect(commandSchema.safeParse({ type: "gitlab.host.approve", baseUrl: "https://gitlab.example.com" }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "risk.accept", path: ".cursor/hooks.json", code: "hook" }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "risk.accept", path: ".cursor/hooks.json", code: "large" }).success).toBe(false);
    expect(commandProvider({ type: "gitlab.host.approve", baseUrl: "https://gitlab.example.com" })).toBe("gitlab");
    expect(commandGitlabHost({ type: "gitlab.host.approve", baseUrl: "https://gitlab.example.com" })).toBe("https://gitlab.example.com");
  });

  it("accepts a GitLab PAT save and rejects an empty token", () => {
    expect(commandSchema.safeParse({ type: "gitlab.pat.save", baseUrl: "https://gitlab.com", token: "glpat-abcdefghijklmnopqrstuv" }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "gitlab.pat.save", token: "" }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "gitlab.pat.save", token: "x".repeat(2049) }).success).toBe(false);
  });

  it("accepts GitLab token help with an optional host", () => {
    expect(commandSchema.safeParse({ type: "gitlab.pat.help" }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "gitlab.pat.help", baseUrl: "https://gitlab.example.com" }).success).toBe(true);
  });

  it("accepts forget and disconnect and strips secrets from source.save", () => {
    expect(commandSchema.safeParse({ type: "gitlab.pat.forget", baseUrl: "https://gitlab.example.com" }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "source.disconnect" }).success).toBe(true);
    const parsed = commandSchema.parse({ type: "source.save", source: { id: "team", provider: "gitlab", repository: "group/project", profile: "cursor-project", token: "glpat-abcdefghijklmnopqrstuv" } });
    if (parsed.type !== "source.save") throw new Error("expected source.save");
    expect("token" in parsed.source).toBe(false);
  });

  it("routes GitLab PAT commands away from the GitHub session", () => {
    expect(commandProvider({ type: "gitlab.pat.save", token: "x" })).toBe("gitlab");
    expect(commandProvider({ type: "auth.start" })).toBe("github");
    expect(commandProvider({ type: "auth.forget" })).toBe("github");
    expect(commandSchema.safeParse({ type: "auth.forget" }).success).toBe(true);
    expect(commandProvider({ type: "source.save", source: { id: "team", provider: "gitlab", repository: "group/project", profile: "cursor-project" } })).toBe("gitlab");
    expect(commandGitlabHost({ type: "gitlab.pat.forget", baseUrl: "https://gitlab.example.com" })).toBe("https://gitlab.example.com");
    expect(commandProvider({ type: "sync.refresh" })).toBeUndefined();
  });

  it("accepts review and repository open commands", () => {
    expect(commandSchema.safeParse({ type: "review.open" }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "repository.open" }).success).toBe(true);
  });

  it("accepts restore from remote", () => {
    expect(commandSchema.safeParse({ type: "remote.restore" }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "remote.applyAll" }).success).toBe(true);
  });

  it("accepts local-only create and toggle", () => {
    expect(commandSchema.safeParse({ type: "content.localOnly", path: ".cursor/rules/foo.mdc", enabled: true }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "content.localOnly", path: ".cursor/rules/foo.mdc" }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "content.create", request: { type: "rule", name: "privacy", localOnly: true } }).success).toBe(true);
  });

  it("accepts folder selection and legacy assignment commands", () => {
    expect(commandSchema.safeParse({ type: "folder.select", folderUri: "file:///tmp/a" }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "workspace.source.assign", folderUri: "file:///tmp/a" }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "workspace.source.discard" }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "folder.select", folderUri: "" }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "workspace.source.assign", folderUri: "" }).success).toBe(false);
  });
});
