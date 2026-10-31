import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowUp, Check, ChevronDown, ExternalLink, FolderGit2, GitBranch, GitCommitHorizontal, GitPullRequest, Loader2, Plus, RefreshCw } from 'lucide-react';
import type { Project, RepositoryState, Session } from '@mingle/contracts';
import { api, errorMessage } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { cx } from '../../lib/format';
import { useMingle } from '../../store/store';
import { useMutationGuard, useRepository, type RepositoryView } from '../../store/repository';
import { DialogMotionContext, Menu, MenuItem, MenuLabel, MenuSeparator } from '../ui';
import { ActionsStatus } from './ActionsStatus';
import { CommitDialog, CreateBranchDialog, PullRequestDialog, PushDialog } from './GitDialogs';
import { Popover } from './Popover';
import { githubMatches, openExternal, shortSha } from './gitUtil';
import { useRetainedPresence } from '../../lib/motion';

type DialogKind = 'commit' | 'push' | 'pr' | 'branch';

const toast = useMingle.getState().toast;

/* ——— Branch picker ——— */
function BranchPicker({ projectId, sessionId, repo, view, disabledWhy, onCreate }: {
  projectId: string; sessionId: string | null; repo: RepositoryState; view: RepositoryView; disabledWhy: string | null; onCreate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const label = repo.detached ? `detached @ ${shortSha(repo.head)}` : repo.branch ?? 'no commits yet';
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    return repo.branches.filter((b) => !text || b.name.toLowerCase().includes(text));
  }, [repo.branches, query]);

  useEffect(() => { setActive(0); }, [query, open]);

  const close = () => { setOpen(false); setQuery(''); setError(null); };
  const choose = async (index: number) => {
    const branch = filtered[index];
    if (!branch || branch.current || busy || disabledWhy) return;
    if (branch.worktreePath) return;
    setBusy(branch.name);
    setError(null);
    try {
      const result = await api.repositoryBranch(projectId, sessionId, { expectedHead: repo.head, name: branch.name, create: false });
      view.adopt(result);
      void useMingle.getState().refreshNow();
      toast('success', `Switched to ${branch.name}`);
      close();
    } catch (cause) {
      setError(errorMessage(cause));
      void view.refresh();
    } finally {
      setBusy(null);
    }
  };
  const onKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(filtered.length - 1, i + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (event.key === 'Enter') { event.preventDefault(); void choose(active); }
  };
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, listId]);

  return (
    <>
      <button
        ref={anchor} type="button" className={cx('gitbar__btn gitbar__branch', open && 'is-open')} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`Branch: ${label}. Change branch`} title={disabledWhy ?? 'Switch or create a branch'} disabled={Boolean(disabledWhy)} onClick={() => (open ? close() : setOpen(true))}
      >
        <GitBranch size={13} aria-hidden="true" />
        <span className="gitbar__branch-name">{label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      <Popover anchor={anchor} open={open && !disabledWhy} onClose={close} label="Branches" width={300} className="branchpop">
        <input
          className="branchpop__search" data-autofocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
          placeholder="Find a branch" aria-label="Find a branch" role="combobox" aria-expanded="true" aria-controls={listId}
          aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined} autoComplete="off" spellCheck={false}
        />
        <div id={listId} role="listbox" aria-label="Branches" className="branchpop__list">
          {filtered.length === 0 ? <p className="branchpop__empty">{repo.branches.length === 0 ? 'No local branches yet.' : 'No matching branches.'}</p> : null}
          {filtered.map((branch, index) => {
            const elsewhere = Boolean(branch.worktreePath) && !branch.current;
            return (
              <div
                key={branch.name} id={`${listId}-${index}`} role="option" aria-selected={branch.current} aria-disabled={elsewhere || undefined}
                title={elsewhere ? `Checked out in another worktree: ${branch.worktreePath}` : undefined}
                className={cx('branchpop__item', index === active && 'is-active', elsewhere && 'is-disabled')}
                onMouseMove={() => setActive(index)} onClick={() => void choose(index)}
              >
                <span className="branchpop__name">{branch.name}</span>
                {elsewhere ? <small>in another worktree</small> : null}
                {busy === branch.name ? <Loader2 size={13} className="spin" aria-hidden="true" /> : branch.current ? <Check size={13} aria-label="Current branch" /> : null}
              </div>
            );
          })}
        </div>
        {error ? <p className="branchpop__error" role="alert">{error}</p> : null}
        <button type="button" className="branchpop__create" disabled={!repo.head} title={!repo.head ? 'Make a first commit before creating branches' : undefined} onClick={() => { close(); onCreate(); }}>
          <Plus size={13} aria-hidden="true" /> Create new branch…
        </button>
      </Popover>
    </>
  );
}

/* ——— Bar ——— */
export function GitBar({ project, session }: { project: Project; session: Session | null }) {
  const scope = useMemo(() => ({ projectId: project.id, sessionId: session?.id ?? null }), [project.id, session?.id]);
  const view = useRepository(scope);
  const guard = useMutationGuard(scope);
  const { repo, repoError, repoLoading, github, githubError, githubLoading } = view.entry;
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [githubForm, setGithubForm] = useState(false);
  const [githubName, setGithubName] = useState(() => (project.path.split(/[\\/]/).filter(Boolean).at(-1) ?? project.name).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100));
  const [githubVisibility, setGithubVisibility] = useState<'private' | 'public'>('private');
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupMessage, setSetupMessage] = useState<{ text: string; url?: string } | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  useEffect(() => {
    setGithubName((project.path.split(/[\\/]/).filter(Boolean).at(-1) ?? project.name).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100));
    setGithubForm(false);
    setSetupMessage(null);
    setSetupError(null);
  }, [project.id, project.path, project.name]);
  const { value: activeDialog, present: dialogPresent, closing: dialogClosing, key: dialogKey } = useRetainedPresence(dialog, 160);
  const [copied, setCopied] = useState(false);

  const where = session ? (session.isolated ? 'Isolated worktree' : 'Local checkout') : 'Project folder';
  const folder = repo?.root ?? session?.worktreePath ?? project.path;
  const copyFolder = async () => {
    try {
      await copyText(folder);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (cause) {
      toast('error', errorMessage(cause));
    }
  };

  const setupGit = async (createGitHub = false) => {
    setSetupBusy(true);
    setSetupError(null);
    setSetupMessage(null);
    try {
      const result = await api.initializeGit(project.id, createGitHub ? { createGitHub: { name: githubName.trim(), visibility: githubVisibility } } : {});
      await view.refresh();
      if (result.github?.status === 'created') setSetupMessage({ text: 'Git is ready and the GitHub repository was created.', url: result.github.url });
      else if (result.github?.status === 'unavailable') setSetupMessage({ text: `Git is ready locally. GitHub setup is unavailable: ${result.github.reason}` });
      else setSetupMessage({ text: result.notices.length ? `Git is ready. ${result.notices.join(' ')}` : 'Git is ready. New sessions can now use isolated worktrees.' });
      setGithubForm(false);
    } catch (cause) {
      setSetupError(errorMessage(cause));
    } finally {
      setSetupBusy(false);
    }
  };

  const eligible = repo?.changes.filter((c) => c.eligible).length ?? 0;
  const changed = repo?.changes.length ?? 0;
  // Pull request and checks data only describe the branch/commit it was read for, and only while the last read succeeded.
  const githubOk = Boolean(repo && github?.status === 'available' && githubMatches(github, repo) && !githubError);
  const pr = githubOk ? github?.pullRequest ?? null : null;
  const hasRemote = (repo?.remotes.length ?? 0) > 0;
  // An unknown ahead count (null) never means "up to date": pushing stays available and is labelled as unknown.
  const ahead = repo?.ahead ?? null;
  const publishable = Boolean(repo && repo.head && !repo.detached && hasRemote && !repo.upstream);
  const pushable = Boolean(repo && repo.head && !repo.detached && hasRemote && (!repo.upstream || ahead === null || ahead > 0));
  const pushText = publishable ? 'Publish' : ahead === null ? 'Push' : `Push ${ahead}`;

  const commitWhy = guard ?? (!repo ? 'Repository status is not loaded' : eligible === 0 ? (changed === 0 ? 'Working tree is clean' : 'No changed files are eligible to commit') : null);
  const pushWhy = guard ?? (!repo ? 'Repository status is not loaded' : !hasRemote ? 'No remote is configured' : repo.detached ? 'Detached HEAD cannot be pushed' : !repo.head ? 'Commit something first' : repo.upstream && ahead === 0 ? 'Nothing to push — up to date with upstream' : null);
  const prWhy = guard ?? (!repo ? 'Repository status is not loaded'
    : !hasRemote ? 'No remote is configured'
      : repo.detached ? 'Detached HEAD has no branch to open a pull request from'
        : !githubOk ? (github?.status === 'available' ? (githubError ? `GitHub status could not be refreshed: ${githubError}` : 'GitHub status is updating') : github?.notices[0] ?? githubError ?? 'GitHub is not available for this repository')
          : pr ? `Pull request #${pr.number} already exists`
            : !repo.upstream ? 'This branch has no upstream configured — push it first; Mingle never pushes for you' : null);
  const branchWhy = guard ?? (!repo?.head && !repo?.branches.length ? 'No branches yet — make a first commit' : null);

  const whereButton = (
    <button type="button" className="gitbar__where" onClick={() => void copyFolder()} title={`${folder}\nClick to copy the folder path`} aria-label={`${where}: ${folder}. Copy folder path`}>
      <FolderGit2 size={13} aria-hidden="true" />
      <span>{copied ? 'Path copied' : where}</span>
    </button>
  );

  let body;
  if (!repo) {
    body = repoError ? (
      <span className="gitbar__state" role="alert">
        Repository status unavailable: {repoError}
        <button type="button" className="link-btn" onClick={() => void view.refresh()}>Retry</button>
      </span>
    ) : (
      <span className="gitbar__state" role="status"><Loader2 size={12} className="spin" aria-hidden="true" /> {repoLoading ? 'Reading repository…' : 'Waiting for repository status…'}</span>
    );
  } else if (!repo.isRepo) {
    body = (
      <div className="gitbar__setup" aria-label="Set up Git">
        <div className="gitbar__setup-copy"><strong>This folder isn't a Git repository.</strong><span>Sessions work directly in the folder.</span></div>
        <div className="gitbar__setup-actions">
          <button type="button" className="gitbar__setup-button" disabled={setupBusy} onClick={() => void setupGit()}>Set up Git</button>
          <button type="button" className="gitbar__setup-button gitbar__setup-button--primary" disabled={setupBusy} onClick={() => { setGithubForm((open) => !open); setSetupError(null); setSetupMessage(null); }}>Set up Git and create a GitHub repo</button>
        </div>
        {githubForm ? <form className="gitbar__setup-form" onSubmit={(event) => { event.preventDefault(); void setupGit(true); }}>
          <label>Repository name<input required maxLength={100} pattern="[A-Za-z0-9._-]{1,100}" value={githubName} onChange={(event) => setGithubName(event.target.value)} /></label>
          <fieldset><legend>Visibility</legend><label><input type="radio" name="github-visibility" value="private" checked={githubVisibility === 'private'} onChange={() => setGithubVisibility('private')} /> Private</label><label><input type="radio" name="github-visibility" value="public" checked={githubVisibility === 'public'} onChange={() => setGithubVisibility('public')} /> Public</label></fieldset>
          <button type="submit" className="gitbar__setup-button gitbar__setup-button--primary" disabled={setupBusy || !githubName.trim()}>{setupBusy ? <><Loader2 size={13} className="spin" aria-hidden="true" /> Creating…</> : 'Create'}</button>
          <button type="button" className="gitbar__setup-button" disabled={setupBusy} onClick={() => setGithubForm(false)}>Cancel</button>
        </form> : null}
        {setupBusy ? <p className="gitbar__setup-result" role="status" aria-live="polite">Initializing Git…</p> : null}
        {setupError ? <p className="gitbar__setup-error" role="alert" aria-live="assertive">{setupError}</p> : null}
        {setupMessage ? <p className="gitbar__setup-result" role="status" aria-live="polite">{setupMessage.text}{setupMessage.url ? <> <button type="button" className="link-btn" onClick={() => openExternal(setupMessage.url!)}>Open repository</button></> : null}</p> : null}
      </div>
    );
  } else {
    body = (
      <div className="gitbar__controls">
        {repoError ? (
          <button type="button" className="gitbar__stale" title={`Showing the last known status. ${repoError}`} onClick={() => void view.refresh()}><RefreshCw size={11} aria-hidden="true" /> Stale · Retry</button>
        ) : null}
        <ActionsStatus repo={repo} github={github} error={githubError} loading={githubLoading} onRefresh={() => void view.refreshGithub(true)} />
        {pr ? (
          <button type="button" className="gitbar__btn gitbar__pr" onClick={() => openExternal(pr.url)} title={`Open pull request #${pr.number}: ${pr.title}`} aria-label={`Open pull request #${pr.number} on GitHub`}>
            <GitPullRequest size={13} aria-hidden="true" /> #{pr.number}
          </button>
        ) : null}
        <BranchPicker projectId={project.id} sessionId={scope.sessionId} repo={repo} view={view} disabledWhy={branchWhy} onCreate={() => setDialog('branch')} />
        {pushable && !pushWhy ? (
          <button type="button" className="gitbar__btn gitbar__push" onClick={() => setDialog('push')} title={publishable ? 'Publish this branch to the remote' : ahead === null ? `Push to ${repo.upstream} (commits ahead unknown)` : `Push ${ahead} commit${ahead === 1 ? '' : 's'} to ${repo.upstream}`}>
            <ArrowUp size={13} aria-hidden="true" /> {pushText}
          </button>
        ) : null}
        <div className="gitbar__split" role="group" aria-label="Commit">
          <button
            type="button" className="gitbar__commit" disabled={Boolean(commitWhy)} title={commitWhy ?? 'Choose files and commit'} onClick={() => setDialog('commit')}
            aria-label={commitWhy ? `Commit unavailable: ${commitWhy}` : `Commit ${eligible} changed file${eligible === 1 ? '' : 's'}`}
          >
            <GitCommitHorizontal size={13} aria-hidden="true" /> Commit{eligible > 0 ? <span className="gitbar__count">{eligible}</span> : null}
          </button>
          <Menu align="end" width={290} trigger={(props) => (
            <button type="button" className="gitbar__caret" aria-label="More Git actions" title="More Git actions" {...props}><ChevronDown size={12} aria-hidden="true" /></button>
          )}>
            <MenuLabel>Local</MenuLabel>
            <MenuItem icon={<GitCommitHorizontal size={14} />} disabled={Boolean(commitWhy)} why={commitWhy ?? undefined} onSelect={() => setDialog('commit')}>Commit changes…</MenuItem>
            <MenuSeparator />
            <MenuLabel>Remote — only when you choose</MenuLabel>
            <MenuItem icon={<ArrowUp size={14} />} disabled={Boolean(pushWhy)} why={pushWhy ?? undefined} onSelect={() => setDialog('push')} hint={repo.upstream ? (ahead === null ? '↑ unknown' : `↑${ahead}`) : undefined}>{publishable ? 'Publish branch…' : 'Push…'}</MenuItem>
            {pr ? (
              <MenuItem icon={<ExternalLink size={14} />} onSelect={() => { if (!openExternal(pr.url)) toast('error', 'The pull request link is not a web address.'); }} hint={`#${pr.number}`}>View pull request</MenuItem>
            ) : (
              <MenuItem icon={<GitPullRequest size={14} />} disabled={Boolean(prWhy)} why={prWhy ?? undefined} onSelect={() => setDialog('pr')}>Create pull request…</MenuItem>
            )}
            <MenuSeparator />
            <MenuItem icon={<RefreshCw size={14} />} onSelect={() => void view.refresh()}>Refresh status</MenuItem>
          </Menu>
        </div>
      </div>
    );
  }

  const common = repo && repo.isRepo ? { projectId: project.id, sessionId: scope.sessionId, repo, adopt: view.adopt, refresh: view.refresh, blocked: guard, onClose: () => setDialog(null) } : null;
  const retainedCommon = useRef(common);
  if (dialog && common) retainedCommon.current = common;
  const dialogProps = common ?? retainedCommon.current;
  return (
    <div className="gitbar" role="group" aria-label="Repository controls">
      {whereButton}
      {project.isExample ? <span className="gitbar__example" title="This folder belongs to the example workspace">Example</span> : null}
      <span className="gitbar__spacer" />
      {body}
      <DialogMotionContext.Provider key={dialogKey} value={dialogClosing}>
        {dialogPresent && dialogProps && activeDialog === 'commit' ? <CommitDialog {...dialogProps} /> : null}
        {dialogPresent && dialogProps && activeDialog === 'push' ? <PushDialog {...dialogProps} /> : null}
        {dialogPresent && dialogProps && activeDialog === 'branch' ? <CreateBranchDialog {...dialogProps} /> : null}
        {dialogPresent && dialogProps && activeDialog === 'pr' ? <PullRequestDialog {...dialogProps} github={github} /> : null}
      </DialogMotionContext.Provider>
    </div>
  );
}
