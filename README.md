<p align="center">
  <img src="resources/icon.png" width="128" alt="RuleSync">
</p>

# RuleSync

Keep your team’s Cursor rules in sync—and under review.

RuleSync brings `.cursor` rules, hooks, skills, agents, commands, and MCP configuration into one dashboard backed by GitHub or GitLab. Review shared updates before they reach your workspace, edit files normally in Cursor, and send improvements back through a pull request or merge request.

No silent overwrites. No direct writes to `main`. No more asking, “Which version of the rules are we using again?”

Install from [Open VSX](https://open-vsx.org/extension/INVEON-Development/rulesync). Learn more at [racha.github.io/RuleSync](https://racha.github.io/RuleSync/).

## What RuleSync does

- Adds a RuleSync dashboard to Cursor’s Activity Bar.
- Organizes rules, hooks, skills, agents, commands, MCP, and configuration in one library.
- Marks files local-only so Cursor still uses them while RuleSync leaves them out of future proposals. The list stays in editor workspace state, not in `.cursor`.
- Shows incoming, local, and conflicting changes.
- Opens every managed change in Cursor’s native diff viewer.
- Pulls reviewed remote updates one file at a time or all together.
- Publishes local edits to a `rulesync/…` proposal branch and opens GitHub or GitLab to create the PR or MR.
- Checks for remote updates on startup, when the dashboard opens, or on a schedule.
- Supports private GitHub, GitLab.com, and trusted self-hosted GitLab repositories.

## Safer reviews for hooks and automation

Some configuration can do more than change AI writing style. Hooks may run commands, and MCP configuration may start tools or reference credentials. RuleSync gives these files an extra approval step:

1. Hook files, MCP configuration, executables, binaries, and secret-looking content are flagged.
2. You review the exact change in Cursor’s native diff.
3. Apply and publish stay blocked until you explicitly approve that file.
4. Approval is tied to that exact content. Change the file and RuleSync asks again.

Files larger than 5 MiB are rejected. The checks are practical guardrails, not a substitute for reviewing code—surprise shell commands are rarely the fun kind of surprise.

## Setup

Open the RuleSync icon in the Activity Bar:

1. Activate RuleSync for the workspace.
2. Connect GitHub through the RuleSync GitHub App, or connect GitLab with a personal access token using the `api` scope.
3. Choose the repository and branch containing the team’s `.cursor/` folder.
4. Review the first sync and pull the files you want.

For self-hosted GitLab, confirm the trusted HTTPS host before entering a token. Each folder has one source. Multi-root windows keep folders independent.

## Repository layout

No manifest is required. RuleSync syncs repository-root `.cursor/**` only. Existing `rulesync.yml` files are ignored.

```text
.cursor/
  rules/
  hooks.json
  skills/
  agents/
  commands/
  mcp.json
```

If the repository has no default branch, create it on GitHub or GitLab and check again. RuleSync does not initialize or write the shared branch.

## Trust and credentials

- Tokens stay in Cursor’s secret storage—not in settings or the repository. GitHub sessions can be disconnected.
- Local-only paths are stored in editor workspace state for that folder. RuleSync does not write a registry file under `.cursor`.
- Untrusted workspaces do not read `.cursor`, watch files, use tokens, or contact GitHub or GitLab.
- GitLab credentials stay bound to the host you approved.
- Writes outside `.cursor` and symlinked destinations are rejected.
- The shared branch is checked again before RuleSync creates or updates a proposal.

## What’s new in 1.1.1

- New local-only content
- Fixed folder settings write

## What’s new in 1.1.0

- New GitLab.com and self-hosted GitLab
- New per-file high-risk approval
- New proposal-branch review links
- New independent folder sources
- New restore from remote
- New local disable
- New GitHub disconnect
- Fixed revert of deleted files
- BREAKING rulesync.yml mappings
- BREAKING custom GitHub client IDs
- BREAKING empty-repo default-branch creation
- BREAKING workspace-scoped sources
