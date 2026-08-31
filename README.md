<p align="center">
  <img src="resources/icon.png" width="128" alt="RuleSync">
</p>

# RuleSync

A Cursor extension that reviews and shares `.cursor` rules, hooks, skills, agents, commands, and MCP config from a GitHub repository.

Incoming remote updates are reviewed in native diffs before they touch the workspace. Local edits publish to a proposal branch. Main is never written.

Install from [Open VSX](https://open-vsx.org/extension/INVEON-Development/rulesync). Site: [racha.github.io/RuleSync](https://racha.github.io/RuleSync/).

## What it does

- Adds a RuleSync icon to the Activity Bar.
- Watches gitignored `.cursor/` configuration locally.
- Groups rules, hooks, skills, agents, commands, and MCP configuration in one dashboard.
- Opens managed files in the editor and uses native diffs for review.
- Detects incoming, local, and conflicting changes.
- Applies reviewed remote updates only after confirmation.
- Publishes local changes to a proposal branch, then opens GitHub Compare for the PR.

## Setup

Open the RuleSync icon in the Activity Bar. The dashboard walks through four steps:

1. Activate RuleSync for the opened workspace.
2. Connect GitHub with the RuleSync GitHub App (device code). Install the app on the **rules** repository only.
3. Choose `owner/repo` and branch. Private repositories work. This release supports one source.
4. If the repository has no manifest, RuleSync writes `rulesync.yml` and opens a pull request. Merge it once. You do not edit or maintain that file.

The dashboard then becomes the rule library, changes review, and settings.

## Manifest

RuleSync generates `rulesync.yml` for you. After you merge that PR, it reads the file on its own. Day-to-day work stays in `.cursor`.

```yaml
version: 1

profiles:
  cursor-project:
    adapter: cursor
    scope: project
    source: .cursor
    mode: mirror
```

## Trust

- Tokens stay in Cursor secret storage — not in settings or the repo.
- The GitHub App needs **Contents: Read & write**, **Metadata: Read**, and **Pull requests: Read & write** on the rules repository.
- RuleSync does not push the source branch.
- Hooks, MCP, secret-looking content, binaries, and large files require confirmation before apply or publish.
