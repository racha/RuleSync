import { createRoot } from "react-dom/client";
import React, { useEffect, useMemo, useState } from "react";

import "./styles.css";

type ContentType = "rule" | "hook" | "skill" | "agent" | "command" | "mcp" | "configuration" | "other";
type Status = "synced" | "incoming" | "local" | "conflict" | "converged" | "optedOut" | "proposed";
type ChangeKind = "added" | "modified" | "deleted" | "mode";
type Source = { id: string; provider: "github"; repository: string; ref?: string; profile: string; enabled?: boolean };
type AvailableRepository = { repository: string; defaultBranch: string; private: boolean };
type Item = { path: string; name: string; type: ContentType; status: Status; kind?: ChangeKind; detail?: string; createdBy?: string; lastEditedBy?: string };
type Risk = { path: string; severity: "warning" | "high"; code: string; message: string };
type DashboardState = {
  configured: boolean; projectInitialized: boolean; hasLocalCursorConfiguration: boolean; githubConnected: boolean;
  manifestStatus: "notChecked" | "empty" | "missing" | "ready" | "invalid" | "pending"; manifestMessage?: string;
  trusted: boolean; workspaceName?: string; source?: Source; repositoryUrl?: string; branch?: string; profile?: string;
  status: "unconfigured" | "synced" | "checking" | "offline" | "error" | "needsReview"; statusMessage: string; lastCheckedAt?: string;
  items: Item[]; incomingCount: number; localCount: number; conflictCount: number; warningCount: number; proposedCount: number; risks: Risk[];
  activeProposal?: { branch: string; compareUrl: string; pullRequest?: { number: number; url: string; state: string } };
  availableRepositories: AvailableRepository[]; repositoriesStatus: "idle" | "loading" | "ready" | "error"; repositoriesMessage?: string;
  updateCheck: { mode: "off" | "timed" | "events" | "both"; interval: "hourly" | "daily" | "weekly"; onStart: boolean; onFocus: boolean; onDashboardOpen: boolean };
};

type Command = { type: string; [key: string]: unknown };
declare function acquireVsCodeApi(): { postMessage(message: Command): void; getState(): unknown; setState(state: unknown): void };
const vscode = acquireVsCodeApi();
const empty: DashboardState = { configured: false, projectInitialized: false, hasLocalCursorConfiguration: false, githubConnected: false, manifestStatus: "notChecked", trusted: true, status: "unconfigured", statusMessage: "Initialize RuleSync for this workspace.", items: [], incomingCount: 0, localCount: 0, conflictCount: 0, warningCount: 0, proposedCount: 0, risks: [], availableRepositories: [], repositoriesStatus: "idle", updateCheck: { mode: "both", interval: "daily", onStart: true, onFocus: false, onDashboardOpen: true } };
const labels: Record<ContentType, string> = { rule: "Rules", hook: "Hooks", skill: "Skills", agent: "Agents", command: "Commands", mcp: "MCP", configuration: "Configuration", other: "Other" };
const order: ContentType[] = ["rule", "hook", "skill", "agent", "command", "mcp", "configuration", "other"];

function post(message: Command): void { vscode.postMessage(message); }
function titleCase(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
function statusLabel(status: Status, kind?: ChangeKind): string {
  if (status === "incoming" && kind === "deleted") return "Removed remotely";
  if (status === "local" && kind === "deleted") return "Deleted locally";
  return { synced: "Synced", incoming: "Incoming", local: "Local", conflict: "Conflict", converged: "Converged", optedOut: "Opted out", proposed: "Proposed" }[status];
}
function needsSetup(state: DashboardState): boolean { return !state.projectInitialized || !state.githubConnected || !state.configured; }
function connectSource(repository: string, ref?: string): void {
  post({ type: "source.save", source: { id: "team", provider: "github", repository, ref: ref || undefined, profile: "cursor-project", enabled: true } });
}

interface LogoMarkProps {
  compact?: boolean;
}

function LogoMark({ compact = false }: LogoMarkProps): React.JSX.Element {
  return <svg className={compact ? "brandMark compact" : "brandMark"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 2.75a9.25 9.25 0 1 0 0 18.5 9.25 9.25 0 0 0 0-18.5Z"/><path d="M7 9.1h8.2l-1.9-1.9M17 14.9H8.8l1.9 1.9"/><path d="M15.2 9.1 17 10.9M8.8 14.9 7 13.1"/></svg>;
}

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
  variant?: "plain" | "hero" | "prompt";
}

function PageHeader(props: PageHeaderProps): React.JSX.Element {
  const { eyebrow, title, description, action, variant = "plain" } = props;

  return <header className={`pageHeader ${variant}${action ? " hasAction" : ""}`}>
    <div>
      <span className="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
    </div>

    {action}
  </header>;
}

interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}

function SearchField({ value, onChange, placeholder, label }: SearchFieldProps): React.JSX.Element {
  return <label className="search">
    <svg className="searchIcon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M9.6 9.6 13.2 13.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
    <input aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
  </label>;
}

function App(): React.JSX.Element {
  const [state, setState] = useState<DashboardState>(empty);
  const [section, setSection] = useState<"overview" | "library" | "changes" | "settings">("overview");
  const [filter, setFilter] = useState("");

  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [proposalMessage, setProposalMessage] = useState("chore(rules): propose RuleSync updates");

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const message = event.data as { type?: string; state?: DashboardState; message?: string };
      if (message.type === "state.replace" && message.state) { setState(message.state); setError(undefined); }
      if (message.type === "operation.error") setError(message.message ?? "RuleSync could not complete that action.");
    };
    window.addEventListener("message", receive);
    post({ type: "ready" });
    return () => window.removeEventListener("message", receive);
  }, []);
  useEffect(() => { vscode.setState({ section, filter }); }, [section, filter]);

  const { workspaceName, source, status, statusMessage, trusted } = state;
  const { incomingCount, localCount, conflictCount } = state;
  const pending = incomingCount + localCount + conflictCount;

  if (needsSetup(state)) return <GuidedSetup state={state} error={error} />;

  return <main className="appShell">
    <header className="appHeader">
      <div className="brand">
        <LogoMark />
        <div>
          <span>RULESYNC</span>
          <strong>{workspaceName ?? source?.repository}</strong>
          {source?.repository && <small>{source.repository}</small>}
        </div>
      </div>

      <button className="iconButton" aria-label="Check for updates" title="Check for updates" onClick={() => post({ type: "sync.refresh" })}>↻</button>
    </header>

    <div className={`connection ${status}`}>
      <span className="dot" aria-hidden="true" />
      <span>{statusMessage}</span>
    </div>

    {!trusted && <div className="notice warning"><b>Workspace trust required.</b> Trust this project before editing, applying, or publishing rules.</div>}

    {error && <div className="notice error" role="alert"><span>{error}</span><button onClick={() => setError(undefined)} aria-label="Dismiss">×</button></div>}

    <nav className="tabs" aria-label="RuleSync sections">
      {(["overview", "library", "changes", "settings"] as const).map((item) =>
        <button key={item} className={section === item ? "active" : ""} onClick={() => setSection(item)}>{item === "changes" && pending ? `Changes · ${pending}` : titleCase(item)}</button>
      )}
    </nav>

    {section === "overview" && <Overview state={state} go={setSection} />}
    {section === "library" && <Library state={state} filter={filter} setFilter={setFilter} setCreating={setCreating} />}
    {section === "changes" && <Changes state={state} proposalMessage={proposalMessage} setProposalMessage={setProposalMessage} />}
    {section === "settings" && <Settings state={state} />}

    {creating && <CreateDialog onClose={() => setCreating(false)} />}
  </main>;
}

interface GuidedSetupProps {
  state: DashboardState;
  error?: string;
}

function GuidedSetup({ state, error }: GuidedSetupProps): React.JSX.Element {
  const [repository, setRepository] = useState(state.source?.repository ?? "");
  const [branch, setBranch] = useState(state.source?.ref ?? "main");

  const { workspaceName, source, configured, items, status, statusMessage } = state;
  const { githubConnected, projectInitialized, hasLocalCursorConfiguration } = state;
  const { manifestStatus, manifestMessage, branch: remoteBranch, activeProposal } = state;
  const projectReady = projectInitialized;
  const githubReady = githubConnected;
  const repositoryReady = configured;
  const localRules = items.filter((item) => item.type === "rule");
  const projectLabel = workspaceName ? workspaceName.toUpperCase() : "THIS PROJECT";

  return <main className="setupShell">
    <section className="setupHero">
      <LogoMark />
      <div className="eyebrow">RULESYNC FOR {projectLabel}</div>
      <h1>Make your team’s AI guidance feel native.</h1>
      <p>Keep the project’s Cursor rules, hooks, skills, and automation in one reviewed shared source.</p>
    </section>

    {error && <div className="notice error" role="alert">{error}</div>}

    {!error && !githubReady && configured && <div className="notice checking" role="status">{statusMessage || "GitHub sign-in expired. Connect GitHub again."}</div>}

    {!error && githubReady && status === "checking" && statusMessage && <div className="notice checking" role="status">{statusMessage}</div>}

    <section className="setupSteps" aria-label="RuleSync setup">
      <SetupStep number="1" title="Activate this workspace" complete={projectReady} description={hasLocalCursorConfiguration ? "Found existing .cursor configuration. RuleSync can bring it under review." : "RuleSync will watch .cursor when you add rules to this project."}>
        {!projectReady && <button className="primary" onClick={() => post({ type: "workspace.initialize" })}>Initialize RuleSync</button>}
        {projectReady && <span className="completeText">Workspace ready</span>}
      </SetupStep>

      <SetupStep number="2" title="Connect GitHub" complete={githubReady} locked={!projectReady} description={githubReady ? "GitHub is connected securely for this workspace." : configured ? "Your GitHub session expired. Connect again — RuleSync will keep this repository." : "Authorize RuleSync once, then install it on the rules repository if GitHub asks."}>
        {!githubReady && <>
          <button className="primary" onClick={() => post({ type: "auth.start" })}>Connect GitHub</button>
          <button className="secondary" onClick={() => post({ type: "github.app.install" })}>Install on a repository ↗</button>
        </>}
        {githubReady && <span className="completeText">Connected</span>}
      </SetupStep>

      <SetupStep number="3" title="Choose the shared rules repository" complete={repositoryReady} locked={!githubReady} description={repositoryReady ? `${source?.repository} is connected to this project.` : "Pick a repository RuleSync can already access, or install the app on another one."}>
        {githubReady && !repositoryReady && <RepositoryPicker state={state} repository={repository} setRepository={setRepository} branch={branch} setBranch={setBranch} />}
        {repositoryReady && <span className="completeText">Repository connected</span>}
      </SetupStep>

      {repositoryReady && manifestStatus === "empty" && <SetupStep number="4" title="This repository has no main" description={`${source?.repository ?? "This repository"} has no ${remoteBranch ?? "main"} branch. RuleSync can create it for you.`}>
        <button className="primary" onClick={() => post({ type: "manifest.initialize" })}>Create it for me</button>
      </SetupStep>}

      {repositoryReady && manifestStatus === "missing" && <SetupStep number="4" title="Initialize the rules repository" description="This repository has no rulesync.yml yet. Create the starter file on a proposal branch, then make the pull request on GitHub.">
        <button className="primary" onClick={() => post({ type: "manifest.initialize" })}>Create rulesync.yml branch</button>
      </SetupStep>}

      {repositoryReady && manifestStatus === "pending" && <SetupStep number="4" title="Merge the manifest pull request" complete description={manifestMessage ?? "The starter manifest is ready."}>
        <button className="primary" onClick={() => post({ type: "proposal.openCompare" })}>{activeProposal?.pullRequest ? "Open pull request" : "Open GitHub and create PR"}</button>
      </SetupStep>}

      {repositoryReady && manifestStatus === "invalid" && <SetupStep number="4" title="Fix rulesync.yml" description={manifestMessage ?? "The remote manifest needs attention."}>
        <button className="secondary" onClick={() => post({ type: "sync.refresh" })}>Check again</button>
      </SetupStep>}
    </section>

    {localRules.length > 0 && <section className="setupLocal" aria-label="Local Cursor files">
      <span className="eyebrow">ALREADY IN {projectLabel}</span>
      <strong>{localRules.length} rules found</strong>
      <p>They stay in this folder. After you finish setup they appear in the library so you can publish them.</p>
      <ul>
        {localRules.slice(0, 8).map(({ path, name }) => <li key={path}>{name}</li>)}
        {localRules.length > 8 && <li>+ {localRules.length - 8} more</li>}
      </ul>
    </section>}

    <p className="setupFooter">RuleSync never writes to your main branch. Every shared change is reviewed through GitHub.</p>
  </main>;
}

interface SetupStepProps {
  number: string;
  title: string;
  description: string;
  complete?: boolean;
  locked?: boolean;
  children?: React.ReactNode;
}

function SetupStep(props: SetupStepProps): React.JSX.Element {
  const { number, title, description, complete = false, locked = false, children } = props;

  return <article className={`setupStep ${complete ? "complete" : ""} ${locked ? "locked" : ""}`}>
    <div className="stepNumber">{complete ? "✓" : number}</div>
    <div className="stepBody">
      <h2>{title}</h2>
      <p>{description}</p>
      {children && <div className="stepAction">{children}</div>}
    </div>
  </article>;
}

interface RepositoryPickerProps {
  state: DashboardState;
  repository: string;
  setRepository: (value: string) => void;
  branch: string;
  setBranch: (value: string) => void;
}

function RepositoryPicker(props: RepositoryPickerProps): React.JSX.Element {
  const { state, repository, setRepository, branch, setBranch } = props;
  const [filter, setFilter] = useState("");

  const { availableRepositories, repositoriesStatus, repositoriesMessage } = state;
  const repos = availableRepositories ?? [];
  const visible = repos.filter(({ repository: name }) => name.toLowerCase().includes(filter.toLowerCase()));

  return <>
    {repositoriesStatus === "loading" && <p className="repoHint">Loading repositories…</p>}

    {repositoriesStatus === "error" && <p className="repoHint">{repositoriesMessage ?? "Could not load repositories."}</p>}

    {repositoriesStatus === "ready" && !repos.length && <p className="repoHint">No repositories yet. Install RuleSync on a rules repo, then refresh this list.</p>}

    {repos.length > 3 && <SearchField label="Filter repositories" value={filter} onChange={setFilter} placeholder="Filter repositories" />}

    {visible.length > 0 && <div className="repoList">
      {visible.map((item) => {
        const { repository: name, private: isPrivate, defaultBranch } = item;

        return <button key={name} className="repoChoice" type="button" onClick={() => connectSource(name, defaultBranch)}>
          <span className="fileCopy">
            <strong>{name}</strong>
            <small>{isPrivate ? "Private" : "Public"} · {defaultBranch}</small>
          </span>
          <span className="repoUse">Use</span>
        </button>;
      })}
    </div>}

    <div className="repoPickerActions">
      <button className="secondary" onClick={() => post({ type: "github.app.install" })}>Install on a repository ↗</button>

      <button className="secondary" onClick={() => post({ type: "github.repos.refresh" })}>Refresh list</button>
    </div>

    <details className="customRepo">
      <summary>Use a custom repository</summary>
      <div className="repoForm">
        <label>Repository<input value={repository} onChange={(event) => setRepository(event.target.value)} placeholder="acme/ai-editor-rules" /></label>
        <label>Branch<input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" /></label>
        <button className="primary" disabled={!repository} onClick={() => connectSource(repository, branch)}>Connect repository</button>
      </div>
    </details>
  </>;
}

interface OverviewProps {
  state: DashboardState;
  go: (section: "overview" | "library" | "changes" | "settings") => void;
}

function Overview({ state, go }: OverviewProps): React.JSX.Element {
  const { manifestStatus, source, branch, items, incomingCount, localCount, conflictCount } = state;
  const { workspaceName, activeProposal, manifestMessage } = state;
  const changed = incomingCount + localCount + conflictCount;
  const repo = source?.repository ?? "This repository";
  const ref = branch ?? "main";
  const pullRequest = activeProposal?.pullRequest;

  return <section className="content overview">
    {manifestStatus === "empty" && <PageHeader variant="prompt" eyebrow="NO MAIN BRANCH" title={`${repo} has no ${ref}.`} description={`RuleSync can create empty ${ref} for you. After that you can open pull requests.`} action={<button className="primary" onClick={() => post({ type: "manifest.initialize" })}>Create it for me</button>} />}

    {manifestStatus === "missing" && <PageHeader variant="prompt" eyebrow="REPOSITORY SETUP" title="One small file away from syncing." description="Initialize rulesync.yml on a proposal branch, then merge it on GitHub." action={<button className="primary" onClick={() => post({ type: "manifest.initialize" })}>Initialize repository</button>} />}

    {manifestStatus === "pending" && <PageHeader variant="prompt" eyebrow="AWAITING MERGE" title="Manifest branch is ready." description={manifestMessage} action={<button className="primary" onClick={() => post({ type: "proposal.openCompare" })}>{pullRequest ? "Open pull request" : "Open GitHub"}</button>} />}

    <PageHeader variant="hero" eyebrow="PROJECT STATUS" title={changed ? "Rules need your attention" : items.length ? "Your rules are in sync" : `No managed files in ${workspaceName ?? "this workspace"}`} description={changed ? "Review the changes before they affect the project." : items.length ? "Edit a rule or add a new one whenever the team needs it." : `RuleSync is watching ${workspaceName ?? "this folder"}. Add files under .cursor, then open Library.`} action={<button className="softButton" onClick={() => go(changed ? "changes" : "library")}>{changed ? "Review changes →" : "Browse rules →"}</button>} />

    <div className="metricGrid">
      <Metric value={items.length} label="Managed files" />
      <Metric value={incomingCount} label="Incoming" tone="blue" />
      <Metric value={localCount} label="Local changes" tone="amber" />
      <Metric value={conflictCount} label="Conflicts" tone="red" />
    </div>

    {activeProposal && <div className="proposalCard">
      <div className="proposalIcon">↗</div>
      <div>
        <strong>{pullRequest ? "Pull request detected" : "Proposal branch ready"}</strong>
        <span>{pullRequest ? `#${pullRequest.number}` : activeProposal.branch}</span>
      </div>
      <button className="secondary" onClick={() => post({ type: "proposal.openCompare" })}>{pullRequest ? "Open PR" : "Create PR"}</button>
    </div>}

    <div className="nextAction">
      <span>Next best action</span>
      <strong>{conflictCount ? "Resolve conflicts" : incomingCount ? "Review remote updates" : localCount ? "Publish local changes" : "Create or edit a rule"}</strong>
    </div>
  </section>;
}

interface MetricProps {
  value: number;
  label: string;
  tone?: string;
}

function Metric({ value, label, tone }: MetricProps): React.JSX.Element {
  return <div className={`metric ${tone ?? ""}`}><strong>{value}</strong><span>{label}</span></div>;
}

interface LibraryProps {
  state: DashboardState;
  filter: string;
  setFilter: (filter: string) => void;
  setCreating: (value: boolean) => void;
}

function Library(props: LibraryProps): React.JSX.Element {
  const { state, filter, setFilter, setCreating } = props;
  const visible = useMemo(() => state.items.filter((item) => `${item.name} ${item.path}`.toLowerCase().includes(filter.toLowerCase())), [state.items, filter]);

  return <section className="content library">
    <PageHeader eyebrow="MANAGED CONTENT" title="Rules library" action={<button className="primary" onClick={() => setCreating(true)}>＋ New</button>} />

    <SearchField label="Search rules" value={filter} onChange={setFilter} placeholder="Search rules and configuration" />

    {order.map((type) => {
      const entries = visible.filter((item) => item.type === type);
      if (!entries.length) return null;

      return <details key={type} open>
        <summary><span>{labels[type]}</span><b>{entries.length}</b></summary>
        <div className="fileList">{entries.map((item) => <FileRow key={item.path} item={item} />)}</div>
      </details>;
    })}

    {!visible.length && <div className="empty">
      <LogoMark compact />
      <strong>No managed files yet.</strong>
      <span>Create a rule or finish repository setup to bring shared configuration into this project.</span>
    </div>}
  </section>;
}

interface FileRowProps {
  item: Item;
}

function FileRow({ item }: FileRowProps): React.JSX.Element {
  const [menu, setMenu] = useState(false);
  const { path, name, type, status, kind, detail } = item;
  const removed = kind === "deleted";

  return <article className="fileRow">
    <button className="fileMain" onClick={() => post({ type: "content.open", path })}>
      <span className="fileGlyph">{type === "rule" ? "✦" : type === "hook" ? "⌁" : type === "skill" ? "◇" : "•"}</span>
      <span className="fileCopy"><strong>{name}</strong><small>{detail}</small></span>
      <span className={`badge ${status}${removed ? " deleted" : ""}`}>{statusLabel(status, kind)}</span>
    </button>

    <button type="button" className="fileMore" aria-label={`Actions for ${name}`} aria-expanded={menu} onClick={() => setMenu((open) => !open)}>⋯</button>

    {menu && <div className="fileActions">
      <button onClick={() => post({ type: "content.diff", path, comparison: status === "incoming" ? "remote" : "base" })}>Compare</button>

      {status === "incoming" && <button onClick={() => post({ type: "remote.apply", path })}>{removed ? "Apply deletion" : "Pull"}</button>}

      {status === "local" && <button onClick={() => post({ type: "content.revert", path })}>Revert</button>}

      <button onClick={() => post({ type: "content.rename", path })}>Rename</button>

      <button className="dangerText" onClick={() => post({ type: "content.delete", path })}>Delete</button>
    </div>}
  </article>;
}

interface ChangesProps {
  state: DashboardState;
  proposalMessage: string;
  setProposalMessage: (value: string) => void;
}

function Changes(props: ChangesProps): React.JSX.Element {
  const { state, proposalMessage, setProposalMessage } = props;
  const { items, risks, manifestStatus, source, branch, activeProposal } = state;
  const incoming = items.filter((item) => item.status === "incoming");
  const local = items.filter((item) => item.status === "local");
  const conflicts = items.filter((item) => item.status === "conflict");
  const emptyRepo = manifestStatus === "empty";
  const title = emptyRepo ? "Create main first" : conflicts.length ? "Resolve conflicts" : incoming.length ? "Review remote updates" : local.length ? "Review local changes" : "Nothing to review";
  const description = emptyRepo ? `${source?.repository ?? "This repository"} has no ${branch ?? "main"} branch. RuleSync can create it for you.` : "Open a native diff for every file before applying or publishing changes.";

  return <section className="content changes">
    <PageHeader eyebrow="REVIEW QUEUE" title={title} description={description} />

    {emptyRepo && <button className="primary wide" onClick={() => post({ type: "manifest.initialize" })}>Create it for me</button>}

    {risks.length > 0 && <div className="riskList">
      <strong>Safety review required</strong>
      {risks.map((risk) => {
        const { path, code, message } = risk;

        return <div key={`${path}-${code}`} className="risk">
          <span>!</span>
          <div><code>{path}</code><small>{message}</small></div>
        </div>;
      })}
      <button className="secondary" onClick={() => post({ type: "risks.accept" })}>Accept these files</button>
    </div>}

    <ChangeGroup title="Conflicts" items={conflicts} conflict />
    <ChangeGroup title="Incoming from GitHub" items={incoming} />
    <ChangeGroup title="Changed in this project" items={local} />

    {!emptyRepo && !conflicts.length && incoming.length > 0 && <button className="primary wide" onClick={() => post({ type: "remote.applyAll" })}>Apply {incoming.length} remote change{incoming.length === 1 ? "" : "s"}</button>}

    {!emptyRepo && !conflicts.length && !incoming.length && local.length > 0 && <div className="publishPanel">
      <label>Commit message<input value={proposalMessage} onChange={(event) => setProposalMessage(event.target.value)} /></label>
      <button className="primary wide" onClick={() => post({ type: "proposal.publish", message: proposalMessage })}>{activeProposal ? "Update proposal branch" : "Publish proposal branch"}</button>
      <small>RuleSync publishes a branch. You create the final pull request on GitHub.</small>
    </div>}

    {!emptyRepo && !conflicts.length && !incoming.length && !local.length && <div className="empty">
      <strong>Everything is clear.</strong>
      <span>When you edit a managed file, the review queue will appear here.</span>
    </div>}
  </section>;
}

interface ChangeGroupProps {
  title: string;
  items: Item[];
  conflict?: boolean;
}

function ChangeGroup({ title, items, conflict = false }: ChangeGroupProps): React.JSX.Element | null {
  if (!items.length) return null;

  return <div className="changeGroup">
    <h3>{title}<span>{items.length}</span></h3>
    {items.map((item) => {
      const { path, name, status, kind } = item;

      return <div key={path} className="change">
        <button onClick={() => post({ type: "content.diff", path, comparison: status === "incoming" ? "remote" : "base" })}>
          <strong>{name}</strong>
          <small>{path}</small>
        </button>
        {conflict && <div>
          <button onClick={() => post({ type: "conflict.resolve", path, resolution: "local" })}>Keep local</button>

          <button onClick={() => post({ type: "conflict.resolve", path, resolution: "remote" })}>Use remote</button>
        </div>}

        {!conflict && status === "incoming" && <div>
          <button onClick={() => post({ type: "remote.apply", path })}>{kind === "deleted" ? "Apply deletion" : "Pull"}</button>
        </div>}
      </div>;
    })}
  </div>;
}

interface SettingsProps {
  state: DashboardState;
}

function Settings({ state }: SettingsProps): React.JSX.Element {
  const { updateCheck: check, source, profile, branch, lastCheckedAt } = state;
  const save = (next: DashboardState["updateCheck"]) => post({ type: "settings.updateCheck", settings: next });
  const scheduled = check.mode === "timed" || check.mode === "both";
  const events = check.mode === "events" || check.mode === "both";

  return <section className="content settings">
    <PageHeader eyebrow="CONNECTION" title="Workspace settings" description="Repository, update checks, and GitHub access." />

    <div className="settingCard">
      <span>Repository</span>
      <strong>{source?.repository}</strong>
      <small>Profile: {profile} · Branch: {branch ?? "default"}</small>
    </div>

    <div className="settingCard">
      <span>Check for updates</span>
      <strong>When RuleSync looks at GitHub</strong>
      <div className="choiceRow" role="group" aria-label="Update check mode">
        {([["off", "Off"], ["timed", "Schedule"], ["events", "Events"], ["both", "Both"]] as const).map(([value, label]) =>
          <button key={value} type="button" className={check.mode === value ? "choice active" : "choice"} onClick={() => save({ ...check, mode: value })}>{label}</button>
        )}
      </div>
      {scheduled && <label>How often
        <select value={check.interval} onChange={(event) => save({ ...check, interval: event.target.value as DashboardState["updateCheck"]["interval"] })}>
          <option value="hourly">Hourly</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
      </label>}
      {events && <div className="tickList">
        <label className="tick"><input type="checkbox" checked={check.onStart} onChange={(event) => save({ ...check, onStart: event.target.checked })} /><span>When the editor starts</span></label>
        <label className="tick"><input type="checkbox" checked={check.onFocus} onChange={(event) => save({ ...check, onFocus: event.target.checked })} /><span>When this window is focused again</span></label>
        <label className="tick"><input type="checkbox" checked={check.onDashboardOpen} onChange={(event) => save({ ...check, onDashboardOpen: event.target.checked })} /><span>When you open RuleSync</span></label>
      </div>}
      <small>{lastCheckedAt ? `Last checked ${new Date(lastCheckedAt).toLocaleString()}` : "Not checked yet."}</small>
      <button className="secondary" onClick={() => post({ type: "sync.refresh" })}>Check now</button>
    </div>

    <div className="settingCard">
      <span>GitHub App</span>
      <small>Install RuleSync on another rules repository.</small>
      <button className="secondary" onClick={() => post({ type: "github.app.install" })}>Install on a repository ↗</button>
    </div>

    <div className="settingCard">
      <span>Advanced options</span>
      <small>Opt-outs and GitHub App configuration are available in editor settings.</small>
      <button className="secondary" onClick={() => post({ type: "settings.open" })}>Open settings</button>
    </div>

    <button className="danger wide" onClick={() => post({ type: "source.disconnect" })}>Disconnect repository</button>
  </section>;
}

interface CreateDialogProps {
  onClose: () => void;
}

function CreateDialog({ onClose }: CreateDialogProps): React.JSX.Element {
  const [type, setType] = useState<ContentType>("rule");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const [ruleMode, setRuleMode] = useState<"always" | "auto" | "agent" | "manual">("always");
  const [globs, setGlobs] = useState("");
  const [relativePath, setRelativePath] = useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    post({ type: "content.create", request: { type, name, description, ruleMode, globs, relativePath } });
    onClose();
  };

  return <div className="modalBackdrop" role="presentation">
    <form className="modal" onSubmit={submit} aria-label="Create managed content">
      <header>
        <div>
          <span className="eyebrow">ADD TO THIS PROJECT</span>
          <strong>Create managed content</strong>
        </div>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </header>

      <label>Type
        <select value={type} onChange={(event) => setType(event.target.value as ContentType)}>
          {order.map((item) => <option key={item} value={item}>{labels[item]}</option>)}
        </select>
      </label>

      <label>Name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} required /></label>

      <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What should this guide or automate?" /></label>

      {type === "other" && <label>Path under .cursor<input value={relativePath} onChange={(event) => setRelativePath(event.target.value)} placeholder="templates/example.md" required /></label>}

      {type === "rule" && <>
        <label>Rule behavior
          <select value={ruleMode} onChange={(event) => setRuleMode(event.target.value as typeof ruleMode)}>
            <option value="always">Always apply</option>
            <option value="auto">Apply to matching files</option>
            <option value="agent">Agent requested</option>
            <option value="manual">Manual</option>
          </select>
        </label>
        {ruleMode === "auto" && <label>Glob pattern<input value={globs} onChange={(event) => setGlobs(event.target.value)} placeholder="**/*.ts" /></label>}
      </>}

      <footer>
        <button type="button" className="secondary" onClick={onClose}>Cancel</button>

        <button className="primary" type="submit">Create</button>
      </footer>
    </form>
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
