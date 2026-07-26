import { useEffect, useState } from 'react';
import { getHealth, postPlan } from './api';
import type {
  Action,
  ActionResult,
  PageContext,
  PlanResponse,
  SwaraExecuteResultMessage,
  SwaraExtractResultMessage,
  SwaraMessage,
} from '../types';

type HealthStatus = 'checking' | 'connected' | 'offline';

const makeSessionId = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `swara-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function isPageContext(value: unknown): value is PageContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as PageContext).fields) &&
    typeof (value as PageContext).title === 'string'
  );
}

function extractPage(value: unknown): PageContext | null {
  if (isPageContext(value)) return value;
  const result = value as Partial<SwaraExtractResultMessage> | null;
  return result && result.type === 'SWARA_EXTRACT_RESULT' && isPageContext(result.page)
    ? result.page
    : null;
}

function extractResults(value: unknown): ActionResult[] | null {
  if (Array.isArray(value)) return value as ActionResult[];
  const result = value as Partial<SwaraExecuteResultMessage> | null;
  return result && result.type === 'SWARA_EXECUTE_RESULT' && Array.isArray(result.results)
    ? result.results
    : null;
}

function contentScriptError(message?: string): string {
  if (message?.toLowerCase().includes('receiving end')) {
    return 'Could not reach this page. Reload the tab, then try scanning again.';
  }
  return message ?? 'Could not reach this page. Reload the tab, then try scanning again.';
}

async function sendToActiveTab(message: SwaraMessage): Promise<unknown> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error('No active tab is available.');

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id!, message, (response: unknown) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(contentScriptError(lastError.message)));
        return;
      }
      resolve(response);
    });
  });
}

function App() {
  const [sessionId] = useState(makeSessionId);
  const [health, setHealth] = useState<HealthStatus>('checking');
  const [page, setPage] = useState<PageContext | null>(null);
  const [instruction, setInstruction] = useState('');
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [results, setResults] = useState<ActionResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [filling, setFilling] = useState(false);
  const [expandedActions, setExpandedActions] = useState<Set<number>>(new Set());

  useEffect(() => {
    const checkHealth = async () => {
      try {
        await getHealth();
        setHealth('connected');
      } catch {
        setHealth('offline');
      }
    };
    void checkHealth();
  }, []);

  const scanPage = async () => {
    setScanning(true);
    setError(null);
    setPlan(null);
    setResults(null);
    try {
      const response = await sendToActiveTab({ type: 'SWARA_EXTRACT' });
      const extractedPage = extractPage(response);
      if (!extractedPage) throw new Error('The page returned an invalid scan result. Try reloading the tab.');
      setPage(extractedPage);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : 'Unable to scan this page.');
    } finally {
      setScanning(false);
    }
  };

  const createPlan = async () => {
    if (!page || !instruction.trim()) return;
    setPlanning(true);
    setError(null);
    setResults(null);
    try {
      const response = await postPlan({ sessionId, page, instruction: instruction.trim() });
      setPlan(response);
      setHealth('connected');
    } catch (planError) {
      setHealth('offline');
      setError(planError instanceof Error ? planError.message : 'Unable to create a plan.');
    } finally {
      setPlanning(false);
    }
  };

  const fillForm = async () => {
    if (!plan || plan.status !== 'ready' || plan.actions.length === 0) return;
    setFilling(true);
    setError(null);
    try {
      const response = await sendToActiveTab({ type: 'SWARA_EXECUTE', actions: plan.actions });
      const actionResults = extractResults(response);
      if (!actionResults) throw new Error('The page returned an invalid fill result. Try reloading the tab.');
      setResults(actionResults);
    } catch (fillError) {
      setError(fillError instanceof Error ? fillError.message : 'Unable to fill this form.');
    } finally {
      setFilling(false);
    }
  };

  const fieldQuestion = (fieldId: string) =>
    page?.fields.find((field) => field.fieldId === fieldId)?.question ?? fieldId;

  const filledCount = results?.filter((result) => result.ok).length ?? 0;

  return (
    <main className="app">
      <header className="app-header">
        <div>
          <p className="eyebrow">Form companion</p>
          <h1>Swara</h1>
        </div>
        <div className={`connection connection--${health}`} title={`Server ${health}`}>
          <span className="connection-dot" />
          <span>{health === 'connected' ? 'Connected' : health === 'checking' ? 'Checking' : 'Server offline'}</span>
        </div>
      </header>

      <section className="workflow-section scan-section" aria-labelledby="scan-heading">
        <div className="section-heading">
          <div>
            <p className="step">01</p>
            <h2 id="scan-heading">Scan this page</h2>
          </div>
          <button className="button button--secondary" type="button" onClick={() => void scanPage()} disabled={scanning}>
            {scanning ? <><span className="spinner" />Scanning</> : 'Scan page'}
          </button>
        </div>
        {page ? (
          <>
            <p className="page-title">{page.title}</p>
            <p className="field-count">{page.fields.length} {page.fields.length === 1 ? 'field' : 'fields'} found</p>
            <details className="field-list">
              <summary>View extracted fields</summary>
              <ul>
                {page.fields.map((field) => (
                  <li key={field.fieldId}>
                    <span className="field-question">{field.question}</span>
                    <span className="field-meta"><span className="badge">{field.type}</span>{field.required && <span className="required">Required</span>}</span>
                  </li>
                ))}
              </ul>
            </details>
          </>
        ) : <p className="hint">Scan the form to see its questions and prepare a plan.</p>}
      </section>

      <section className="workflow-section" aria-labelledby="instruct-heading">
        <div className="section-heading">
          <div>
            <p className="step">02</p>
            <h2 id="instruct-heading">What should Swara do?</h2>
          </div>
          <span className="mic-placeholder" aria-label="Voice input coming soon">Mic soon</span>
        </div>
        <textarea
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder="Fill this using my profile, use my AI experience, don't mention my current startup, keep it concise."
          aria-label="Instructions for Swara"
          rows={4}
        />
        <button className="button button--primary full-width" type="button" onClick={() => void createPlan()} disabled={!page || !instruction.trim() || planning}>
          {planning ? <><span className="spinner" />Planning</> : 'Plan'}
        </button>
      </section>

      {error && <p className="error" role="alert">{error}</p>}

      {plan && (
        <section className="preview" aria-labelledby="preview-heading">
          <div className="preview-heading">
            <p className="step">03</p>
            <h2 id="preview-heading">Review the plan</h2>
          </div>
          <p className="plan-summary">{plan.actions.length} fields ready <span>·</span> {plan.relevantContext.length} pieces of context used</p>

          {plan.status === 'needs_clarification' && (
            <section className="clarifications" aria-label="Clarifications needed">
              <h3>Before filling, Swara needs your input</h3>
              <ul>{plan.clarifications.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
            </section>
          )}

          <PlanSection title="Context used" className="context-used">
            {plan.relevantContext.length ? plan.relevantContext.map((item) => (
              <div className="context-item" key={`${item.key}-${item.reason}`}><span className="check-mark">✓</span><p><strong>{item.key}</strong><span>{item.reason}</span></p></div>
            )) : <p className="empty-copy">No saved context was needed.</p>}
          </PlanSection>

          <PlanSection title="Excluded" className="context-excluded">
            {plan.excludedContext.length ? plan.excludedContext.map((item) => (
              <div className="context-item excluded" key={`${item.key}-${item.reason}`}><span className="exclude-mark">—</span><p><strong>{item.key}</strong><span>{item.reason}</span></p></div>
            )) : <p className="empty-copy">No context was excluded.</p>}
          </PlanSection>

          <PlanSection title="Memory" className="memory-section">
            {plan.memoryUpdates.length ? plan.memoryUpdates.map((memory, index) => (
              <article className="memory-card" key={`${memory.key}-${index}`}>
                <div className="memory-badges"><span className={`badge memory-type memory-type--${memory.type}`}>{memory.type}</span><span className="badge scope-badge">{memory.scope}</span></div>
                <strong>{memory.key}</strong>
                <p className="memory-value">{memory.value}</p>
                {memory.oldValue && <p className="old-value">Replaces: {memory.oldValue}</p>}
                <p className="memory-reason">{memory.reason}</p>
              </article>
            )) : <p className="empty-copy">No memory updates proposed.</p>}
          </PlanSection>

          <PlanSection title="Proposed actions" className="actions-section">
            {plan.actions.map((action, index) => {
              const isLong = action.value.length > 140;
              const isExpanded = expandedActions.has(index);
              return <article className="action-card" key={`${action.fieldId}-${index}`}>
                <div className="action-topline"><strong>{fieldQuestion(action.fieldId)}</strong><span className="badge action-badge">{action.action}</span></div>
                <p className={isLong && !isExpanded ? 'action-value is-truncated' : 'action-value'}>{action.value || 'No value required'}</p>
                {isLong && <button className="text-button" type="button" onClick={() => setExpandedActions((current) => { const next = new Set(current); isExpanded ? next.delete(index) : next.add(index); return next; })}>{isExpanded ? 'Show less' : 'Show full value'}</button>}
                {action.reasoning && <p className="action-reasoning">{action.reasoning}</p>}
              </article>;
            })}
          </PlanSection>

          {plan.unresolved.length > 0 && <p className="unresolved">Left unchanged: {plan.unresolved.join(' · ')}</p>}

          <button className="button button--primary full-width fill-button" type="button" onClick={() => void fillForm()} disabled={plan.status !== 'ready' || plan.actions.length === 0 || filling}>
            {filling ? <><span className="spinner" />Filling form</> : 'Fill form'}
          </button>
        </section>
      )}

      {results && (
        <section className="results" aria-live="polite">
          <p className="results-summary">{filledCount} of {results.length} filled</p>
          <ul>{results.map((result, index) => <li className={result.ok ? 'result-ok' : 'result-error'} key={`${result.fieldId}-${index}`}><span>{result.ok ? 'OK' : 'Error'}</span><p><strong>{fieldQuestion(result.fieldId)}</strong>{result.error && <small>{result.error}</small>}</p></li>)}</ul>
        </section>
      )}
    </main>
  );
}

function PlanSection({ title, className, children }: { title: string; className: string; children: React.ReactNode }) {
  return <section className={`plan-section ${className}`}><h3>{title}</h3>{children}</section>;
}

export default App;
