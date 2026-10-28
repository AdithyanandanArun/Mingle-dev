import { useMemo } from 'react';
import type { Approval, GroupSnapshot, Message, Session, SessionRun, Task } from '@mingle/contracts';
import { cx } from '../../lib/format';
import {
  CHANGE_STATUS_LABEL, buildGroupResultModel, reportPreview, type GroupResultStatus, type ResultAgent, type ResultLead, type ResultReport,
} from '../../lib/groupResults';
import { Markdown } from '../Markdown';
import { AgentIdentity } from './AgentIdentity';
import { RecoveryPanel } from './RecoveryPanel';
import '../../styles/group-results.css';

const TONE: Record<GroupResultStatus, string> = {
  pending: 'quiet', 'in-progress': 'active', paused: 'warn', failed: 'alert', stopped: 'alert', blocked: 'alert',
  'follow-up': 'warn', finalizing: 'active', unknown: 'quiet', review: 'review', accepted: 'quiet', responded: 'quiet',
};

const AGENT_REPORT_NOTE = 'Checks and integration below are reported by this agent.';

function ReportBody({ report, label }: { report: ResultReport; label: string }) {
  return (
    <section className="group-result__report" aria-label={label}>
      <h4 className="group-result__report-label">{label}{report.taskTitles.length ? <span> · {report.taskTitles.join(', ')}</span> : null}</h4>
      {report.text !== null ? <Markdown text={report.text} /> : <p className="group-result__quiet">{report.note}</p>}
    </section>
  );
}

function LeadReport({ lead }: { lead: ResultLead }) {
  const { report } = lead;
  return (
    <section className="group-result__lead" aria-label="Lead report">
      <div className="group-result__lead-head">
        <span className="group-result__label">Lead report</span>
        <AgentIdentity handle={lead.handle} identityKey={lead.sessionId} provider={lead.provider} removed={lead.removed} />
        {lead.state ? <span className="group-result__state">{lead.state}</span> : null}
      </div>
      {report.text !== null ? (
        <>
          <p className="group-result__preview">{reportPreview(report.text)}</p>
          <details className="group-result__details">
            <summary>Full report</summary>
            <p className="group-result__quiet">{AGENT_REPORT_NOTE}</p>
            <div className="group-result__body"><Markdown text={report.text} /></div>
          </details>
        </>
      ) : <p className="group-result__quiet">{report.note}</p>}
    </section>
  );
}

function AgentRow({ agent }: { agent: ResultAgent }) {
  const { workspace } = agent;
  const written = agent.reports.filter((report) => report.text !== null);
  const preview = written.length ? written[written.length - 1]!.text! : null;
  const hasDetails = agent.reports.length > 0 || workspace.location !== null || workspace.scope.length > 0 || workspace.paths.length > 0 || workspace.notes.length > 0;
  return (
    <li className="group-result__agent">
      <div className="group-result__agent-head">
        <AgentIdentity handle={agent.handle} identityKey={agent.sessionId} provider={agent.provider} removed={agent.removed} role={agent.isLead ? 'Lead' : undefined} />
        {agent.state ? <span className="group-result__state">{agent.state}</span> : null}
      </div>
      {agent.tasks.length ? (
        <ul className="group-result__tasks" aria-label="Assigned tasks">
          {agent.tasks.map((task) => (
            <li key={task.id}><span className="group-result__task-title">{task.title}</span><span className="group-result__task-status">{task.label}</span>
              {task.verificationSummary ? <small className="group-result__task-verification">Verification · {task.verificationSummary}</small> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {agent.problems.map((problem) => <p key={problem} className="group-result__problem">{problem}</p>)}
      {preview ? <p className="group-result__preview"><span className="group-result__quiet">Agent report · </span>{reportPreview(preview, 280)}</p> : null}
      {hasDetails ? (
        <details className="group-result__details">
          <summary>{agent.reports.length ? 'Agent report and workspace' : 'Workspace details'}</summary>
          {agent.reports.length ? <p className="group-result__quiet">{AGENT_REPORT_NOTE}</p> : null}
          {agent.reports.map((report) => <ReportBody key={report.key} report={report} label="Agent report" />)}
          <div className="group-result__workspace">
            <h4 className="group-result__report-label">Workspace</h4>
            <dl>
              <dt>Location</dt>
              <dd>
                {workspace.location ? <code>{workspace.location}</code> : 'Not recorded'}
                {workspace.isolated === null ? '' : workspace.isolated ? ' · isolated worktree' : ' · shared project folder'}
              </dd>
              {workspace.scope.length ? (
                <>
                  <dt>Assigned scope</dt>
                  <dd><ul>{workspace.scope.map((entry) => <li key={entry}><code>{entry}</code></li>)}</ul></dd>
                </>
              ) : null}
              <dt>Changed paths</dt>
              <dd>
                {workspace.paths.length
                  ? <ul>{workspace.paths.map((entry) => (
                      <li key={entry.path}><code>{entry.path}</code> <span className="group-result__quiet">{CHANGE_STATUS_LABEL[entry.status]}{entry.runs > 1 ? ` · ${entry.runs} runs` : ''}</span></li>
                    ))}</ul>
                  : <span className="group-result__quiet">None recorded.</span>}
              </dd>
            </dl>
            <p className="group-result__quiet">Changes recorded in this checkout.</p>
            {workspace.notes.map((note) => <p key={note} className="group-result__quiet">{note}</p>)}
          </div>
        </details>
      ) : null}
    </li>
  );
}

export function GroupResultSummary({ snapshot, sessions, messages, runs, tasks, approvals = [] }: {
  snapshot: GroupSnapshot; sessions: readonly Session[]; messages: readonly Message[]; runs: readonly SessionRun[]; tasks: readonly Task[]; approvals?: readonly Approval[];
}) {
  const model = useMemo(() => buildGroupResultModel({ snapshot, sessions, messages, runs, tasks, approvals }), [snapshot, sessions, messages, runs, tasks, approvals]);
  if (!model) return null;
  const compact = model.active && model.status !== 'paused';
  const meta = [
    ...model.facts,
    model.changedPathCount ? `${model.changedPathCount} changed ${model.changedPathCount === 1 ? 'path' : 'paths'} in ${model.workspaceCount} ${model.workspaceCount === 1 ? 'workspace' : 'workspaces'}` : null,
  ].filter(Boolean);
  return (
    <section className={cx('group-result', `group-result--${TONE[model.status]}`)} aria-label="Team result">
      <header className="group-result__head">
        <span className="group-result__label">Team result</span>
        {!compact && model.requestExcerpt ? <p className="group-result__request" title={model.requestExcerpt}>{model.requestExcerpt}</p> : null}
        <div aria-live="polite" aria-atomic="true">
          <h3 className="group-result__title">{model.title}</h3>
          <p className="group-result__summary">{model.summary}</p>
          {model.detail ? <p className="group-result__detail">{model.detail}</p> : null}
        </div>
        {!compact && meta.length ? <p className="group-result__meta">{meta.join(' · ')}</p> : null}
      </header>
      <RecoveryPanel snapshot={snapshot} sessions={sessions} runs={runs} tasks={tasks} />
      {!compact && model.lead ? <LeadReport lead={model.lead} /> : null}
      {!compact && model.agents.length ? (
        <ul className="group-result__agents" aria-label="Participating agents">
          {model.agents.map((agent) => <AgentRow key={agent.memberId} agent={agent} />)}
        </ul>
      ) : null}
      {!compact ? <p className="group-result__caveat">{model.caveat}</p> : null}
    </section>
  );
}
