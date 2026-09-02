import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import "./styles.css";
import { awaitsHost, connectSetupCopy, defaultSetupProvider, emptyRepositoryCopy, folderSwitchReset, gitlabHostSessionReady, hostIsApproved, itemMenuEntries, legacyWorkspaceNotice, matchesBusy, proposalCommitMessage, recoveredGitlabUrl, repositorySetupCopy, setupGitlabKind, setupStatusNotice, splitRisks, visibleSetupRepos, type ItemMenuEntry } from "./setup.js";

type ContentType = "rule" | "hook" | "skill" | "agent" | "command" | "mcp" | "configuration" | "other";
type Status = "synced" | "incoming" | "local" | "conflict" | "converged" | "optedOut" | "proposed";
type ChangeKind = "added" | "modified" | "deleted" | "mode";
type Source = { id: string; provider: "github" | "gitlab"; repository: string; baseUrl?: string; ref?: string; profile: string; enabled?: boolean };
type AvailableRepository = { repository: string; defaultBranch: string; private: boolean };
type Item = { path: string; name: string; type: ContentType; status: Status; kind?: ChangeKind; detail?: string; createdBy?: string; lastEditedBy?: string; disabled?: boolean; localOnly?: boolean; inWorkspace?: boolean };
type Risk = { path: string; severity: "warning" | "high"; code: string; message: string };
type DashboardState = {
  configured: boolean; projectInitialized: boolean; hasLocalCursorConfiguration: boolean; githubConnected: boolean;   gitlabConnected: boolean; gitlabBaseUrl?: string; gitlabApprovedHosts?: string[];
  manifestStatus: "notChecked" | "empty" | "missing" | "ready" | "invalid" | "pending"; manifestMessage?: string;
  trusted: boolean; workspaceName?: string; source?: Source; repositoryUrl?: string; branch?: string; profile?: string;
  status: "unconfigured" | "synced" | "checking" | "offline" | "error" | "needsReview"; statusMessage: string; lastCheckedAt?: string;
  items: Item[]; incomingCount: number; localCount: number; conflictCount: number; warningCount: number; proposedCount: number; risks: Risk[];
  activeProposal?: { branch: string; compareUrl: string; pullRequest?: { number: number; url: string; state: string } };
  availableRepositories: AvailableRepository[]; repositoriesStatus: "idle" | "loading" | "ready" | "error"; repositoriesProvider?: "github" | "gitlab"; repositoriesMessage?: string;
  updateCheck: { mode: "off" | "timed" | "events" | "both"; interval: "hourly" | "daily" | "weekly"; onStart: boolean; onFocus: boolean; onDashboardOpen: boolean };
  folders: Array<{ uri: string; name: string; configured: boolean; status: "unconfigured" | "synced" | "checking" | "offline" | "error" | "needsReview"; incomingCount: number; localCount: number; conflictCount: number }>;
  selectedFolderUri?: string;
  legacyWorkspaceSource?: { provider: "github" | "gitlab"; repository: string };
};

type Command = { type: string; [key: string]: unknown };
declare function acquireVsCodeApi(): { postMessage(message: Command): void; getState(): unknown; setState(state: unknown): void };
const vscode = acquireVsCodeApi();
const empty: DashboardState = { configured: false, projectInitialized: false, hasLocalCursorConfiguration: false, githubConnected: false, gitlabConnected: false, gitlabApprovedHosts: [], manifestStatus: "notChecked", trusted: true, status: "unconfigured", statusMessage: "Initialize RuleSync for this folder.", items: [], incomingCount: 0, localCount: 0, conflictCount: 0, warningCount: 0, proposedCount: 0, risks: [], availableRepositories: [], repositoriesStatus: "idle", updateCheck: { mode: "both", interval: "daily", onStart: true, onFocus: false, onDashboardOpen: true }, folders: [] };
const labels: Record<ContentType, string> = { rule: "Rules", hook: "Hooks", skill: "Skills", agent: "Agents", command: "Commands", mcp: "MCP", configuration: "Configuration", other: "Other" };
const order: ContentType[] = ["rule", "hook", "skill", "agent", "command", "mcp", "configuration", "other"];

function post(message: Command): void { vscode.postMessage(message); }

const Actions = createContext<{ busy?: string; run: (message: Command, key?: string) => void }>({ run: post });
function useActions(): { busy?: string; run: (message: Command, key?: string) => void } { return useContext(Actions); }

interface ActionButtonProps extends React.ComponentPropsWithoutRef<"button"> {
  action: Command;
  actionKey?: string;
  busyLabel?: string;
  pending?: boolean;
}

function ActionButton(props: ActionButtonProps): React.JSX.Element {
  const { action, actionKey, busyLabel, pending = false, children, className, disabled, type = "button", ...rest } = props;
  const { busy, run } = useActions();
  const key = actionKey ?? action.type;
  const waiting = pending || busy === key;

  return <button type={type} {...rest} className={[className, waiting ? "busy" : ""].filter(Boolean).join(" ")} disabled={disabled || waiting} aria-busy={waiting} onClick={type === "submit" ? undefined : () => run(action, key)}>{waiting && busyLabel ? busyLabel : children}</button>;
}

function titleCase(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
function statusLabel(status: Status, kind?: ChangeKind): string {
  if (status === "incoming" && kind === "deleted") return "Removed remotely";
  if (status === "local" && kind === "deleted") return "Deleted locally";
  return { synced: "Synced", incoming: "Incoming", local: "Local", conflict: "Conflict", converged: "Converged", optedOut: "Opted out", proposed: "Proposed" }[status];
}
interface FolderBarProps {
  state: DashboardState;
}

function FolderBar({ state }: FolderBarProps): React.JSX.Element | null {
  const { folders, selectedFolderUri } = state;
  const { run } = useActions();
  const [open, setOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const selected = folders.find(({ uri }) => uri === selectedFolderUri) ?? folders[0];

  useEffect(() => {
    if (!open) return;
    const onPointer = ({ target }: MouseEvent) => { if (!barRef.current?.contains(target as Node)) setOpen(false); };
    const onKey = ({ key }: KeyboardEvent) => { if (key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open]);
  useEffect(() => { setOpen(false); }, [selectedFolderUri]);

  if (folders.length <= 1) return null;

  const select = (folderUri: string) => {
    setOpen(false);
    if (folderUri !== selectedFolderUri) run({ type: "folder.select", folderUri });
  };

  return <div className="folderBar" ref={barRef}>
    <button type="button" className="folderBarTrigger" aria-label="RuleSync folder" aria-haspopup="listbox" aria-expanded={open} aria-controls="folder-bar-menu" onClick={() => setOpen((value) => !value)}>
      <span className="eyebrow">FOLDER</span>
      <span className="folderBarCurrent">
        <strong>{selected?.name ?? "Folder"}</strong>
        {selected && !selected.configured && <small>Not configured</small>}
      </span>
      <svg className="folderBarChevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.2 8 10.2 12 6.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
    </button>

    {open && <div className="folderBarMenu" id="folder-bar-menu" role="listbox" aria-label="Workspace folders">
      {folders.map((folder) => {
        const { uri, name, configured, incomingCount, localCount, conflictCount } = folder;
        const pending = incomingCount + localCount + conflictCount;

        return <button key={uri} type="button" role="option" aria-selected={uri === selectedFolderUri} className={uri === selectedFolderUri ? "active" : undefined} onClick={() => select(uri)}>
          <span>{name}</span>
          {!configured && <small>Not configured</small>}
          {pending > 0 && <b>{pending}</b>}
        </button>;
      })}
    </div>}
  </div>;
}

interface LegacyBannerProps {
  state: DashboardState;
}

function LegacyBanner({ state }: LegacyBannerProps): React.JSX.Element | null {
  const { legacyWorkspaceSource, selectedFolderUri, folders } = state;
  if (!legacyWorkspaceSource || !selectedFolderUri) return null;
  const selected = folders.find((folder) => folder.uri === selectedFolderUri);

  return <div className="notice warning" role="status">
    <span>{legacyWorkspaceNotice(legacyWorkspaceSource, selected?.name ?? "this folder")}</span>

    <div className="legacyActions">
      <ActionButton className="primary" action={{ type: "workspace.source.assign", folderUri: selectedFolderUri }} busyLabel="Assigning…">Assign to {selected?.name ?? "this folder"}</ActionButton>

      <ActionButton className="secondary" action={{ type: "workspace.source.discard" }}>Discard</ActionButton>
    </div>
  </div>;
}

function sessionReady(state: DashboardState): boolean {
  if (state.source?.provider === "gitlab") return state.gitlabConnected;
  if (state.source?.provider === "github") return state.githubConnected;
  return state.githubConnected || state.gitlabConnected;
}
function needsSetup(state: DashboardState): boolean { return !state.projectInitialized || !sessionReady(state) || !state.configured; }

function isGitlab(state: DashboardState, setupProvider?: "github" | "gitlab"): boolean {
  return (setupProvider ?? state.source?.provider) === "gitlab";
}
function hostLabel(state: DashboardState, setupProvider?: "github" | "gitlab"): "GitHub" | "GitLab" {
  return isGitlab(state, setupProvider) ? "GitLab" : "GitHub";
}
function reviewNoun(state: DashboardState, setupProvider?: "github" | "gitlab"): "pull request" | "merge request" {
  return isGitlab(state, setupProvider) ? "merge request" : "pull request";
}
function reviewShort(state: DashboardState, setupProvider?: "github" | "gitlab"): "PR" | "MR" {
  return isGitlab(state, setupProvider) ? "MR" : "PR";
}

function proposalActionLabel(state: DashboardState): string {
  const short = reviewShort(state);
  return state.activeProposal?.pullRequest ? `Open ${short} on ${hostLabel(state)}` : `Create ${short} on ${hostLabel(state)}`;
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
  const [busy, setBusy] = useState<string>();
  const [creating, setCreating] = useState(false);
  const generatedProposal = useMemo(() => proposalCommitMessage(state.items.filter(({ status }) => status === "local").map(({ path, kind, type }) => ({ path, kind: kind ?? "modified", contentType: type }))), [state.items]);
  const [proposalMessage, setProposalMessage] = useState(generatedProposal);
  const [customProposal, setCustomProposal] = useState(false);
  const lastStatusMessage = useRef(state.statusMessage);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const run = (message: Command, key = message.type): void => {
    if (busyRef.current === key) return;
    if (awaitsHost(message.type)) setBusy(key);
    post(message);
  };

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const message = event.data as { type?: string; state?: DashboardState; message?: string; command?: string };
      if (message.type === "state.replace" && message.state) {
        setState(message.state);
        setError(undefined);
        if (message.state.status !== "checking") setBusy((current) => current === "sync.refresh" ? undefined : current);
      }
      if (message.type === "operation.error") { setError(message.message ?? "RuleSync could not complete that action."); setBusy(undefined); }
      if (message.type === "operation.done") setBusy((current) => matchesBusy(current, message.command) ? undefined : current);
    };
    window.addEventListener("message", receive);
    post({ type: "ready" });
    return () => window.removeEventListener("message", receive);
  }, []);
  useEffect(() => { vscode.setState({ section, filter }); }, [section, filter]);
  useEffect(() => {
    if (state.githubConnected) setBusy((current) => current === "auth.start" ? undefined : current);
    if (state.gitlabConnected) setBusy((current) => current === "gitlab.pat.save" ? undefined : current);
    if (state.repositoriesStatus === "ready" || state.repositoriesStatus === "error") setBusy((current) => current === "github.repos.refresh" || current === "gitlab.repos.refresh" ? undefined : current);
  }, [state.githubConnected, state.gitlabConnected, state.repositoriesStatus]);
  useEffect(() => {
    const { statusMessage } = state;
    if (statusMessage.startsWith("Proposal branch is ready") && lastStatusMessage.current !== statusMessage) setSection("overview");
    lastStatusMessage.current = statusMessage;
  }, [state.statusMessage]);
  useEffect(() => { if (!customProposal) setProposalMessage(generatedProposal); }, [generatedProposal, customProposal]);
  useEffect(() => {
    const { creating, customProposal, section } = folderSwitchReset();
    setCreating(creating);
    setCustomProposal(customProposal);
    setSection(section);
  }, [state.selectedFolderUri]);

  const editProposal = (next: string): void => {
    if (!next.trim()) { setCustomProposal(false); setProposalMessage(generatedProposal); return; }
    setCustomProposal(true);
    setProposalMessage(next);
  };

  const { workspaceName, source, status, statusMessage, trusted } = state;
  const { incomingCount, localCount, conflictCount } = state;
  const pending = incomingCount + localCount + conflictCount;

  return <Actions.Provider value={{ busy, run }}>
    <FolderBar state={state} />

    {needsSetup(state) ? <GuidedSetup key={state.selectedFolderUri ?? "setup"} state={state} error={error} /> : <main className="appShell">
    <header className="appHeader">
      <div className="brand">
        <LogoMark />
        <div>
          <span>RULESYNC</span>
          <strong>{workspaceName ?? source?.repository}</strong>
          {source?.repository && <small>{source.repository}</small>}
        </div>
      </div>

      <ActionButton className="iconButton" action={{ type: "sync.refresh" }} pending={status === "checking"} aria-label="Check for updates" title="Check for updates"><span className="refreshGlyph" aria-hidden="true">↻</span></ActionButton>
    </header>

    <div className={`connection ${status}`}>
      <span className="dot" aria-hidden="true" />
      <span>{statusMessage}</span>
    </div>

    {!trusted && <div className="notice warning"><b>Workspace trust required.</b> Trust this project before editing, applying, or publishing rules.</div>}

    <LegacyBanner state={state} />

    {error && <div className="notice error" role="alert"><span>{error}</span><button onClick={() => setError(undefined)} aria-label="Dismiss">×</button></div>}

    <nav className="tabs" aria-label="RuleSync sections">
      {(["overview", "library", "changes", "settings"] as const).map((item) =>
        <button key={item} className={section === item ? "active" : ""} onClick={() => setSection(item)}>{item === "changes" && pending ? `Changes · ${pending}` : titleCase(item)}</button>
      )}
    </nav>

    {section === "overview" && <Overview state={state} go={setSection} />}
    {section === "library" && <Library state={state} filter={filter} setFilter={setFilter} setCreating={setCreating} />}
    {section === "changes" && <Changes state={state} proposalMessage={proposalMessage} setProposalMessage={editProposal} />}
    {section === "settings" && <Settings state={state} />}

    {creating && <CreateDialog onClose={() => setCreating(false)} />}
  </main>}
  </Actions.Provider>;
}

interface GuidedSetupProps {
  state: DashboardState;
  error?: string;
}

function GuidedSetup({ state, error }: GuidedSetupProps): React.JSX.Element {
  const initialProvider = defaultSetupProvider(state);
  const [setupProvider, setSetupProvider] = useState<"github" | "gitlab">(initialProvider);
  const [repository, setRepository] = useState(state.source?.provider === initialProvider ? state.source.repository : "");
  const [branch, setBranch] = useState(state.source?.provider === initialProvider ? state.source.ref ?? "main" : "main");
  const [gitlabKind, setGitlabKind] = useState<"cloud" | "self">(setupGitlabKind(state.source));
  const [gitlabBaseUrl, setGitlabBaseUrl] = useState(recoveredGitlabUrl(state.source));
  const [gitlabToken, setGitlabToken] = useState("");
  const { run } = useActions();

  const { workspaceName, source, items, status, statusMessage, trusted } = state;
  const { githubConnected, gitlabConnected, projectInitialized, hasLocalCursorConfiguration } = state;
  const { manifestStatus, branch: remoteBranch } = state;
  const selectedGitlabHost = gitlabKind === "self" ? gitlabBaseUrl.trim() : "https://gitlab.com";
  const hostApproved = gitlabKind === "cloud" || hostIsApproved(selectedGitlabHost, state.gitlabApprovedHosts ?? []);
  const projectReady = projectInitialized;
  const gitlabReady = hostApproved && gitlabHostSessionReady({ gitlabConnected, gitlabBaseUrl: state.gitlabBaseUrl }, selectedGitlabHost);
  const providerReady = setupProvider === "gitlab" ? gitlabReady : githubConnected;
  const host = hostLabel(state, setupProvider);
  const repositoryStep = repositorySetupCopy({ source, setupProvider, selectedHost: setupProvider === "gitlab" ? selectedGitlabHost : undefined, hostLabel: host, providerReady });
  const repositoryReady = repositoryStep.ready;
  const localRules = items.filter((item) => item.type === "rule");
  const projectLabel = workspaceName ? workspaceName.toUpperCase() : "THIS PROJECT";
  const setupNotice = setupStatusNotice(state, setupProvider, providerReady);
  const savedGitlabHost = recoveredGitlabUrl(source);

  useEffect(() => {
    if (source?.provider === setupProvider) {
      setRepository(source.repository);
      setBranch(source.ref ?? "main");
      return;
    }
    setRepository("");
    setBranch("main");
  }, [setupProvider, source?.provider, source?.repository, source?.ref]);

  useEffect(() => {
    if (!providerReady) return;
    post({ type: setupProvider === "gitlab" ? "gitlab.repos.refresh" : "github.repos.refresh" });
  }, [setupProvider, providerReady]);

  useEffect(() => { if (gitlabConnected) setGitlabToken(""); }, [gitlabConnected]);

  return <main className="setupShell">
    <section className="setupHero">
      <LogoMark />
      <div className="eyebrow">RULESYNC FOR {projectLabel}</div>
      <h1>Make your team’s AI guidance feel native.</h1>
      <p>Keep the project’s Cursor rules, hooks, skills, and automation in one reviewed shared source.</p>
    </section>

    {!trusted && <div className="notice warning"><b>Workspace trust required.</b> Trust this project before connecting a Git host or saving a token.</div>}

    <LegacyBanner state={state} />

    {error && <div className="notice error" role="alert">{error}</div>}

    {!error && setupNotice && <div className="notice checking" role="status">{setupNotice}</div>}

    {!error && providerReady && status === "checking" && statusMessage && <div className="notice checking" role="status">{statusMessage}</div>}

    <section className="setupSteps" aria-label="RuleSync setup">
      <SetupStep number="1" title="Activate this folder" complete={projectReady} description={hasLocalCursorConfiguration ? "Found existing .cursor configuration. RuleSync can bring it under review." : "RuleSync will watch .cursor when you add rules to this folder."}>
        {!projectReady && <ActionButton className="primary" disabled={!trusted} action={{ type: "workspace.initialize" }} busyLabel="Initializing…">Initialize RuleSync</ActionButton>}
        {projectReady && <span className="completeText">Folder ready</span>}
      </SetupStep>

      <SetupStep number="2" title={`Connect ${host}`} complete={providerReady} locked={!projectReady} description={connectSetupCopy({ providerReady, setupProvider, gitlabKind, hostApproved, savedHost: savedGitlabHost, hostLabel: host, configured: Boolean(source) })}>
        <div className="choiceRow" role="radiogroup" aria-label="Rules provider">
          <button type="button" className={setupProvider === "github" ? "choice active" : "choice"} onClick={() => setSetupProvider("github")}>GitHub</button>
          <button type="button" className={setupProvider === "gitlab" && gitlabKind === "cloud" ? "choice active" : "choice"} onClick={() => { setSetupProvider("gitlab"); setGitlabKind("cloud"); }}>GitLab.com</button>
          <button type="button" className={setupProvider === "gitlab" && gitlabKind === "self" ? "choice active" : "choice"} onClick={() => { setSetupProvider("gitlab"); setGitlabKind("self"); if (!gitlabBaseUrl.trim()) setGitlabBaseUrl(recoveredGitlabUrl(source)); }}>Self-hosted GitLab</button>
        </div>
        {setupProvider === "github" && !providerReady && <>
          {statusMessage.startsWith("Waiting for GitHub") && <p className="repoHint">{statusMessage}</p>}

          <ActionButton className="primary" disabled={!trusted} action={{ type: "auth.start" }} busyLabel="Waiting for GitHub…">Sign in with GitHub</ActionButton>
        </>}
        {setupProvider === "gitlab" && !providerReady && <form className="patForm" onSubmit={(event) => {
          event.preventDefault();
          if (!hostApproved) return;
          run({ type: "gitlab.pat.save", baseUrl: selectedGitlabHost, token: gitlabToken });
        }}>
          {gitlabKind === "self" && <label>GitLab URL<input value={gitlabBaseUrl} onChange={(event) => setGitlabBaseUrl(event.target.value)} placeholder="https://gitlab.example.com" autoComplete="url" /></label>}

          {gitlabKind === "self" && !hostApproved && <ActionButton className="primary" disabled={!trusted || !gitlabBaseUrl.trim()} action={{ type: "gitlab.host.approve", baseUrl: gitlabBaseUrl }} busyLabel="Confirming…">Confirm {gitlabBaseUrl.trim() || "host"}</ActionButton>}

          {hostApproved && <label>Personal access token<input type="password" value={gitlabToken} onChange={(event) => setGitlabToken(event.target.value)} autoComplete="off" required /></label>}

          {hostApproved && <aside className="tokenGuide" aria-label="GitLab token access">
            <strong>What the token must allow</strong>
            <p>On GitLab: avatar → Edit profile → Access → Personal access tokens. Enable <code>api</code> (Legacy token on current GitLab). That one scope is enough for RuleSync to:</p>
            <ul>
              <li>List projects you can write to</li>
              <li>Read <code>.cursor</code> rules, hooks, and skills</li>
              <li>Publish a proposal branch</li>
              <li>Open a merge request</li>
            </ul>
            <p>Developer role on the rules project is enough. Leave admin and sudo off. <code>read_api</code> or repository-only scopes cannot create merge requests.</p>
            <button type="button" onClick={() => post({ type: "gitlab.pat.help", baseUrl: selectedGitlabHost })}>Create a token with api selected</button>
          </aside>}

          {hostApproved && <ActionButton className="primary" type="submit" disabled={!trusted || !gitlabToken.trim()} action={{ type: "gitlab.pat.save", baseUrl: selectedGitlabHost, token: gitlabToken }} busyLabel="Checking token…">Save token</ActionButton>}
        </form>}
        {providerReady && <span className="completeText">Connected</span>}

        {providerReady && setupProvider === "github" && <ActionButton className="secondary" action={{ type: "auth.forget" }} busyLabel="Disconnecting…">Disconnect GitHub</ActionButton>}

        {providerReady && setupProvider === "gitlab" && <ActionButton className="secondary" action={{ type: "gitlab.pat.forget", baseUrl: selectedGitlabHost }} busyLabel="Forgetting…">Use a different token</ActionButton>}
      </SetupStep>

      <SetupStep number="3" title="Choose the shared rules repository" complete={repositoryReady} locked={!providerReady} description={repositoryStep.description}>
        {providerReady && !repositoryReady && <RepositoryPicker state={state} repository={repository} setRepository={setRepository} branch={branch} setBranch={setBranch} setupProvider={setupProvider} gitlabBaseUrl={selectedGitlabHost} />}
        {repositoryReady && <span className="completeText">Repository connected</span>}
      </SetupStep>

      {repositoryReady && manifestStatus === "empty" && <SetupStep number="4" title={emptyRepositoryCopy({ repository: source?.repository, branch: remoteBranch, host }).title} description={emptyRepositoryCopy({ repository: source?.repository, branch: remoteBranch, host }).description}>
        {state.repositoryUrl && <a className="secondary" href={state.repositoryUrl}>{`Open ${source?.repository} on ${host}`}</a>}

        <ActionButton className="primary" action={{ type: "sync.refresh" }} busyLabel="Checking…">Check again</ActionButton>
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

    <p className="setupFooter">All RuleSync remote writes target proposal branches only.</p>
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
  setupProvider: "github" | "gitlab";
  gitlabBaseUrl?: string;
}

function RepositoryPicker(props: RepositoryPickerProps): React.JSX.Element {
  const { state, repository, setRepository, branch, setBranch, setupProvider, gitlabBaseUrl } = props;
  const [filter, setFilter] = useState("");

  const { availableRepositories, repositoriesStatus, repositoriesMessage, repositoriesProvider } = state;
  const listing = repositoriesStatus === "loading" && repositoriesProvider === setupProvider;
  const repos = visibleSetupRepos({ setupProvider, repositoriesProvider, repositories: availableRepositories ?? [] });
  const visible = repos.filter(({ repository: name }) => name.toLowerCase().includes(filter.toLowerCase()));

  return <>
    {repositoriesStatus === "error" && repositoriesProvider === setupProvider && <p className="repoHint">{repositoriesMessage ?? "Could not load repositories."}</p>}

    {repositoriesStatus === "ready" && repositoriesProvider === setupProvider && !repos.length && <p className="repoHint">{setupProvider === "gitlab" ? "No projects yet. Create a GitLab project the token can access, then refresh this list." : "No repositories yet. Install RuleSync on a rules repo, then refresh this list."}</p>}

    {repos.length > 3 && <SearchField label="Filter repositories" value={filter} onChange={setFilter} placeholder="Filter repositories" />}

    {visible.length > 0 && <p className="repoHint">Click a repository to connect it to this folder.</p>}

    {visible.length > 0 && <div className="repoList">
      {visible.map((item) => {
        const { repository: name, private: isPrivate, defaultBranch } = item;

        return <ActionButton key={name} className="repoChoice" action={{ type: "source.save", source: { id: "team", provider: setupProvider, repository: name, ref: defaultBranch || undefined, profile: "cursor-project", enabled: true, ...(setupProvider === "gitlab" ? { baseUrl: gitlabBaseUrl } : {}) } }} actionKey={`source.save:${name}`} busyLabel="Using repository…" aria-label={`Use ${name}`}>
          <span className="fileCopy">
            <strong>{name}</strong>
            <small>{isPrivate ? "Private" : "Public"} · {defaultBranch}</small>
          </span>
          <span className="repoUse">Use this repository</span>
        </ActionButton>;
      })}
    </div>}

    <div className="repoPickerActions">
      {setupProvider === "github" && <button className="secondary" onClick={() => post({ type: "github.app.install" })}>Install on a repository ↗</button>}

      <ActionButton className="secondary" action={{ type: setupProvider === "gitlab" ? "gitlab.repos.refresh" : "github.repos.refresh" }} pending={listing}>Refresh list</ActionButton>
    </div>

    <details className="customRepo">
      <summary>Use a custom repository</summary>
      <div className="repoForm">
        <label>Repository<input value={repository} onChange={(event) => setRepository(event.target.value)} placeholder={setupProvider === "gitlab" ? "group/sub/project" : "acme/ai-editor-rules"} /></label>
        <label>Branch<input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" /></label>
        <ActionButton className="primary" disabled={!repository} action={{ type: "source.save", source: { id: "team", provider: setupProvider, repository, ref: branch || undefined, profile: "cursor-project", enabled: true, ...(setupProvider === "gitlab" ? { baseUrl: gitlabBaseUrl } : {}) } }} actionKey={`source.save:${repository}`} busyLabel="Connecting…">Connect repository</ActionButton>
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
  const { workspaceName, activeProposal, repositoryUrl } = state;
  const changed = incomingCount + localCount + conflictCount;
  const emptyCopy = emptyRepositoryCopy({ repository: source?.repository, branch, host: hostLabel(state) });
  const pullRequest = activeProposal?.pullRequest;

  return <section className="content overview">
    {manifestStatus === "empty" && <PageHeader variant="prompt" eyebrow="NO DEFAULT BRANCH" title={emptyCopy.title} description={emptyCopy.description} action={<ActionButton className="primary" action={{ type: "sync.refresh" }} busyLabel="Checking…">Check again</ActionButton>} />}

    {manifestStatus === "empty" && repositoryUrl && <p><a href={repositoryUrl}>{`Open ${source?.repository} on ${hostLabel(state)}`}</a></p>}

    <PageHeader variant="hero" eyebrow="PROJECT STATUS" title={changed ? "Rules need your attention" : items.length ? "Your rules are in sync" : `No managed files in ${workspaceName ?? "this folder"}`} description={changed ? "Review the changes before they affect the project." : items.length ? "Edit a rule or add a new one whenever the team needs it." : `RuleSync is watching ${workspaceName ?? "this folder"}. Add files under .cursor, then open Library.`} action={<button className="softButton" onClick={() => go(changed ? "changes" : "library")}>{changed ? "Review changes →" : "Browse rules →"}</button>} />

    <div className="metricGrid">
      <Metric value={items.length} label="Managed files" />
      <Metric value={incomingCount} label="Incoming" tone="blue" />
      <Metric value={localCount} label="Local changes" tone="amber" />
      <Metric value={conflictCount} label="Conflicts" tone="red" />
    </div>

    {activeProposal && <div className="proposalCard">
      <div className="proposalIcon">↗</div>
      <div>
        <strong>{pullRequest ? `${titleCase(reviewNoun(state))} detected` : "Proposal branch ready"}</strong>
        <span>{pullRequest ? `#${pullRequest.number}` : activeProposal.branch}</span>
      </div>
      <ActionButton className="primary" action={{ type: "proposal.openCompare" }} busyLabel={`Opening ${hostLabel(state)}…`}>{proposalActionLabel(state)}</ActionButton>
    </div>}
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

interface ItemMenuProps {
  x: number;
  y: number;
  entries: ItemMenuEntry[];
  anchor: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

function ItemMenu({ x, y, entries, anchor, onClose }: ItemMenuProps): React.JSX.Element {
  const { busy, run } = useActions();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointer = ({ target }: MouseEvent) => {
      const node = target as Node;
      if (ref.current?.contains(node) || anchor.current?.contains(node)) return;
      onClose();
    };
    const onKey = ({ key }: KeyboardEvent) => { if (key === "Escape") onClose(); };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    const left = Math.max(8, Math.min(x - width, window.innerWidth - width - 8));
    const top = y + height > window.innerHeight - 8 ? Math.max(8, y - height - 4) : y + 4;
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }, [x, y]);

  return createPortal(<div ref={ref} className="itemMenu" role="menu" style={{ left: x, top: y }}>
    {entries.map((entry, index) => {
      if ("separator" in entry) return <div key={`sep:${index}`} className="itemMenuSep" role="separator" />;
      const { label, action, actionKey, danger } = entry;
      const key = actionKey ?? `${action.type}:${label}`;

      return <button key={key} type="button" role="menuitem" className={danger ? "dangerText" : undefined} disabled={busy === key} onClick={() => { run(action, key); onClose(); }}>{label}</button>;
    })}
  </div>, document.body);
}

function toggleItemMenu(event: React.MouseEvent<HTMLButtonElement>, open: { x: number; y: number } | undefined, setOpen: (next: { x: number; y: number } | undefined) => void): void {
  if (open) { setOpen(undefined); return; }
  const { bottom, right } = event.currentTarget.getBoundingClientRect();
  setOpen({ x: right, y: bottom });
}

interface FileRowProps {
  item: Item;
}

function FileRow({ item }: FileRowProps): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const moreRef = useRef<HTMLButtonElement>(null);
  const { path, name, type, status, kind, detail, disabled, localOnly } = item;
  const removed = kind === "deleted";

  return <article className="fileRow">
    <button className="fileMain" onClick={() => post({ type: "content.open", path })}>
      <span className="fileGlyph">{type === "rule" ? "✦" : type === "hook" ? "⌁" : type === "skill" ? "◇" : "•"}</span>
      <span className="fileCopy"><strong>{name}</strong><small>{detail}</small></span>
      <span className="fileBadges">
        {disabled && <span className="badge disabled">Disabled</span>}
        {localOnly ? <span className="badge localOnly">Local only</span> : <span className={`badge ${status}${removed ? " deleted" : ""}`}>{statusLabel(status, kind)}</span>}
      </span>
    </button>

    <button ref={moreRef} type="button" className="fileMore" aria-label={`Actions for ${name}`} aria-haspopup="menu" aria-expanded={Boolean(menu)} onClick={(event) => toggleItemMenu(event, menu, setMenu)}>⋯</button>

    {menu && <ItemMenu x={menu.x} y={menu.y} entries={itemMenuEntries(item)} anchor={moreRef} onClose={() => setMenu(undefined)} />}
  </article>;
}

interface ChangesProps {
  state: DashboardState;
  proposalMessage: string;
  setProposalMessage: (value: string) => void;
}

function Changes(props: ChangesProps): React.JSX.Element {
  const { state, proposalMessage, setProposalMessage } = props;
  const { items, risks, manifestStatus, source, branch, activeProposal, repositoryUrl } = state;
  const incoming = items.filter((item) => item.status === "incoming" && !item.localOnly);
  const local = items.filter((item) => item.status === "local" && !item.localOnly);
  const conflicts = items.filter((item) => item.status === "conflict" && !item.localOnly);
  const emptyRepo = manifestStatus === "empty";
  const onlyLocalDeletes = !conflicts.length && !incoming.length && local.length > 0 && local.every(({ kind }) => kind === "deleted");
  const { high, warnings } = splitRisks(risks);
  const emptyCopy = emptyRepositoryCopy({ repository: source?.repository, branch, host: hostLabel(state) });
  const title = emptyRepo ? emptyCopy.title : conflicts.length ? "Resolve conflicts" : incoming.length ? "Review remote updates" : local.length ? "Review local changes" : "Nothing to review";
  const description = emptyRepo ? emptyCopy.description : "Open a native diff for every file before applying or publishing changes.";

  return <section className="content changes">
    <PageHeader eyebrow="REVIEW QUEUE" title={title} description={description} />

    {emptyRepo && repositoryUrl && <a className="secondary" href={repositoryUrl}>{`Open ${source?.repository} on ${hostLabel(state)}`}</a>}

    {emptyRepo && <ActionButton className="primary wide" action={{ type: "sync.refresh" }} busyLabel="Checking…">Check again</ActionButton>}

    {high.length > 0 && <div className="riskList">
      <strong>High-risk files need a per-file accept</strong>
      {high.map((risk) => {
        const { path, code, message } = risk;

        return <div key={`${path}-${code}`} className="risk">
          <span>!</span>
          <div><code>{path}</code><small>{message}</small></div>
          <div className="riskActions">
            <button onClick={() => post({ type: "content.diff", path, comparison: "remote" })}>Review Diff</button>

            <ActionButton action={{ type: "risk.accept", path, code }} actionKey={`risk.accept:${path}:${code}`} busyLabel="Accepting…">Accept</ActionButton>
          </div>
        </div>;
      })}
    </div>}

    {warnings.length > 0 && <div className="riskList">
      <strong>Safety review required</strong>
      {warnings.map((risk) => {
        const { path, code, message } = risk;

        return <div key={`${path}-${code}`} className="risk">
          <span>!</span>
          <div><code>{path}</code><small>{message}</small></div>
        </div>;
      })}
      <ActionButton className="secondary" action={{ type: "risks.accept" }} busyLabel="Accepting…">Accept these files</ActionButton>
    </div>}

    <ChangeGroup title="Conflicts" items={conflicts} conflict />
    <ChangeGroup title={`Incoming from ${hostLabel(state)}`} items={incoming} />
    <ChangeGroup title="Changed in this project" items={local} />

    {!emptyRepo && !conflicts.length && incoming.length > 0 && <ActionButton className="primary wide" action={{ type: "remote.applyAll" }} busyLabel="Applying…">Apply {incoming.length} remote change{incoming.length === 1 ? "" : "s"}</ActionButton>}

    {!emptyRepo && (local.length > 0 || incoming.length > 0 || conflicts.length > 0) && <ActionButton className={onlyLocalDeletes ? "primary wide" : "secondary wide"} action={{ type: "remote.restore" }} busyLabel="Restoring…">Restore from remote</ActionButton>}

    {!emptyRepo && !conflicts.length && !incoming.length && local.length > 0 && <div className="publishPanel">
      <label>Commit message<input value={proposalMessage} onChange={(event) => setProposalMessage(event.target.value)} /></label>
      <ActionButton className="primary wide" action={{ type: "proposal.publish", message: proposalMessage }} busyLabel={activeProposal ? "Updating…" : "Publishing…"}>{activeProposal ? "Update proposal branch" : "Publish proposal branch"}</ActionButton>

      {activeProposal && <ActionButton className="primary wide" action={{ type: "proposal.openCompare" }} busyLabel={`Opening ${hostLabel(state)}…`}>{proposalActionLabel(state)}</ActionButton>}

      <small>All RuleSync remote writes target proposal branches only. You create the final {reviewNoun(state)} on {hostLabel(state)}.</small>
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
    {items.map((item) => <ChangeRow key={item.path} item={item} conflict={conflict} />)}
  </div>;
}

interface ChangeRowProps {
  item: Item;
  conflict?: boolean;
}

function ChangeRow({ item, conflict = false }: ChangeRowProps): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const moreRef = useRef<HTMLButtonElement>(null);
  const { path, name, status, kind } = item;

  return <div className="change">
    <button onClick={() => post({ type: "content.diff", path, comparison: status === "incoming" ? "remote" : "base" })}>
      <strong>{name}</strong>
      <small>{path}</small>
    </button>

    <span className={`badge ${status}${kind === "deleted" ? " deleted" : ""}`}>{statusLabel(status, kind)}</span>

    <button ref={moreRef} type="button" className="fileMore" aria-label={`Actions for ${name}`} aria-haspopup="menu" aria-expanded={Boolean(menu)} onClick={(event) => toggleItemMenu(event, menu, setMenu)}>⋯</button>

    {menu && <ItemMenu x={menu.x} y={menu.y} entries={itemMenuEntries(item, conflict)} anchor={moreRef} onClose={() => setMenu(undefined)} />}
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
    <PageHeader eyebrow="CONNECTION" title="Folder settings" description={`This folder’s repository, editor-wide update checks, and ${hostLabel(state)} access.`} />

    <div className="settingCard">
      <span>Repository</span>
      <strong>{source?.repository}</strong>
      <small>Profile: {profile} · Branch: {branch ?? "default"}{source?.provider === "gitlab" ? ` · ${source.baseUrl ?? "https://gitlab.com"}` : ""}</small>
    </div>

    <div className="settingCard">
      <span>Check for updates</span>
      <strong>When RuleSync looks at the connected source</strong>
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
      <ActionButton className="secondary" action={{ type: "sync.refresh" }} busyLabel="Checking…">Check now</ActionButton>
    </div>

    {source?.provider !== "gitlab" && <div className="settingCard">
      <span>GitHub App</span>
      <small>Install RuleSync on another rules repository.</small>
      <button className="secondary" onClick={() => post({ type: "github.app.install" })}>Install on a repository ↗</button>
    </div>}

    {source?.provider === "gitlab" && <div className="settingCard">
      <span>GitLab access</span>
      <small>Forget the personal access token for {state.gitlabBaseUrl ?? source.baseUrl ?? "https://gitlab.com"}.</small>
      <ActionButton className="secondary" action={{ type: "gitlab.pat.forget", baseUrl: state.gitlabBaseUrl ?? source.baseUrl }} busyLabel="Forgetting…">Forget GitLab token</ActionButton>
    </div>}

    <ActionButton className="danger wide" action={{ type: "source.disconnect" }} busyLabel="Disconnecting…">Disconnect repository</ActionButton>
  </section>;
}

interface CreateDialogProps {
  onClose: () => void;
}

function CreateDialog({ onClose }: CreateDialogProps): React.JSX.Element {
  const { busy, run } = useActions();
  const [type, setType] = useState<ContentType>("rule");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const [ruleMode, setRuleMode] = useState<"always" | "auto" | "agent" | "manual">("always");
  const [globs, setGlobs] = useState("");
  const [relativePath, setRelativePath] = useState("");
  const [localOnly, setLocalOnly] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => { if (submitted && busy !== "content.create") onClose(); }, [submitted, busy, onClose]);

  const request = { type, name, description, ruleMode, globs, relativePath, localOnly };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    run({ type: "content.create", request });
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

      <label className="tick"><input type="checkbox" checked={localOnly} onChange={(event) => setLocalOnly(event.target.checked)} /><span>Local only — keep this file for Cursor, skip RuleSync proposals</span></label>

      <footer>
        <button type="button" className="secondary" onClick={onClose}>Cancel</button>

        <ActionButton className="primary" type="submit" action={{ type: "content.create", request }} busyLabel="Creating…">Create</ActionButton>
      </footer>
    </form>
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
