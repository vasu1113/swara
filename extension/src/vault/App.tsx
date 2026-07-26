import { API_BASE_URL } from '../sidepanel/api';

type ContextItem = {
  id?: string;
  type: 'fact' | 'document' | 'preference' | 'correction' | 'instruction';
  category?: string | null;
  key: string;
  value: string;
  scope: 'persistent' | 'session' | 'task';
  supersededBy?: string | null;
};
type DocumentRow = {
  id: string; filename: string; status: 'pending' | 'processing' | 'done' | 'failed';
  createdAt?: string | null; contextItemsCreated: number; error?: string | null;
};
type Activity = {
  id: string; event: 'created' | 'updated' | 'superseded'; key: string; value: string;
  type: ContextItem['type']; scope?: ContextItem['scope']; updatedAt?: string | null;
};

const categories = ['identity', 'education', 'experience', 'preferences'];
const editableTypes = new Set(['fact', 'preference', 'correction', 'instruction']);
const allowedDocumentExtensions = ['.pdf', '.png', '.jpg', '.jpeg'];
const maxDocumentBytes = 20 * 1024 * 1024;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, options);
  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
    try {
      const body = await response.json() as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch { /* use status text */ }
    throw new Error(detail);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function badge(value: string, kind: 'type' | 'scope' | 'status' = 'type') {
  return el('span', `badge badge--${kind} badge--${value}`, value);
}

function displayDate(value?: string | null) {
  if (!value) return 'Just now';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export function mountVault(root: HTMLElement) {
  root.className = 'vault-root';
  root.replaceChildren();
  const app = el('main', 'vault');
  const notice = el('p', 'notice');
  notice.hidden = true;
  const facts = el('section', 'panel facts-panel');
  const docs = el('section', 'panel documents-panel');
  const activity = el('section', 'panel activity-panel');
  let context: ContextItem[] = [];
  let documents: DocumentRow[] = [];
  let activityItems: Activity[] = [];
  let pollTimer: number | undefined;

  const tell = (message: string, error = false) => {
    notice.textContent = message;
    notice.className = `notice${error ? ' notice--error' : ''}`;
    notice.hidden = !message;
  };

  const load = async () => {
    try {
      [context, documents, activityItems] = await Promise.all([
        request<ContextItem[]>('/context'), request<DocumentRow[]>('/documents'), request<Activity[]>('/activity?limit=50'),
      ]);
      renderFacts(); renderDocuments(); renderActivity();
      const active = documents.some((document) => document.status === 'pending' || document.status === 'processing');
      if (active && pollTimer === undefined) pollTimer = window.setInterval(() => void refreshDocuments(), 2_000);
      if (!active && pollTimer !== undefined) { window.clearInterval(pollTimer); pollTimer = undefined; }
    } catch (error) {
      tell(error instanceof Error ? error.message : 'Could not load the vault.', true);
    }
  };

  const refreshDocuments = async () => {
    try {
      const inFlight = documents.filter((document) => document.status === 'pending' || document.status === 'processing');
      if (!inFlight.length) return;
      // Poll each active document directly. This keeps concurrent OCR jobs
      // independent and exercises the single-document status endpoint.
      const refreshed = await Promise.all(inFlight.map((document) =>
        request<DocumentRow>(`/documents/${encodeURIComponent(document.id)}`),
      ));
      const byId = new Map(refreshed.map((document) => [document.id, document]));
      documents = documents.map((document) => byId.get(document.id) ?? document);
      renderDocuments();
      if (!documents.some((document) => document.status === 'pending' || document.status === 'processing') && pollTimer !== undefined) {
        window.clearInterval(pollTimer); pollTimer = undefined;
        void load();
      }
    } catch (error) { tell(error instanceof Error ? error.message : 'Could not check document status.', true); }
  };

  const saveValue = async (item: ContextItem, value: string) => {
    if (!item.id || !value.trim()) return;
    try {
      await request<ContextItem>(`/context/${encodeURIComponent(item.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: value.trim() }),
      });
      tell('Fact updated.'); await load();
    } catch (error) { tell(error instanceof Error ? error.message : 'Could not update fact.', true); }
  };

  const renderFacts = () => {
    facts.replaceChildren(el('h2', undefined, 'Profile'));
    facts.append(el('p', 'section-copy', 'Saved facts are available to Swara across forms. Document text stays read-only.'));
    for (const category of categories) {
      const group = el('div', 'fact-group');
      const heading = el('div', 'group-heading');
      heading.append(el('h3', undefined, category));
      const add = el('button', 'text-button', 'Add fact'); add.type = 'button';
      add.onclick = () => addFact(category); heading.append(add); group.append(heading);
      const rows = context.filter((item) => (item.category || '').toLowerCase() === category && item.type !== 'document');
      if (!rows.length) group.append(el('p', 'empty', 'No facts yet.'));
      rows.forEach((item) => group.append(factRow(item)));
      facts.append(group);
    }
    const ungrouped = context.filter((item) => !categories.includes((item.category || '').toLowerCase()) && item.type !== 'document');
    if (ungrouped.length) {
      const group = el('div', 'fact-group'); group.append(el('h3', undefined, 'Other'));
      ungrouped.forEach((item) => group.append(factRow(item))); facts.append(group);
    }
    const documentContext = context.filter((item) => item.type === 'document');
    if (documentContext.length) {
      const group = el('div', 'fact-group document-context');
      group.append(el('h3', undefined, 'Document context'));
      documentContext.forEach((item) => group.append(factRow(item)));
      facts.append(group);
    }
  };

  const factRow = (item: ContextItem) => {
    const row = el('article', 'fact-row');
    const meta = el('div', 'fact-meta'); meta.append(el('strong', undefined, item.key), badge(item.type), badge(item.scope, 'scope'));
    row.append(meta);
    const value = el('p', 'fact-value', item.value); row.append(value);
    if (!editableTypes.has(item.type) || !item.id) { row.classList.add('fact-row--readonly'); row.append(el('small', 'readonly', 'Document-derived context')); return row; }
    const controls = el('div', 'row-controls');
    const edit = el('button', 'text-button', 'Edit'); edit.type = 'button';
    edit.onclick = () => {
      const input = document.createElement('input'); input.value = item.value; input.setAttribute('aria-label', `Value for ${item.key}`);
      const save = el('button', 'text-button', 'Save'); save.type = 'button'; save.onclick = () => void saveValue(item, input.value);
      value.replaceWith(input); edit.replaceWith(save);
    };
    const remove = el('button', 'text-button text-button--danger', 'Delete'); remove.type = 'button';
    remove.onclick = async () => {
      if (!confirm(`Delete “${item.key}”?`)) return;
      try { await request<void>(`/context/${encodeURIComponent(item.id!)}`, { method: 'DELETE' }); tell('Fact deleted.'); await load(); }
      catch (error) { tell(error instanceof Error ? error.message : 'Could not delete fact.', true); }
    };
    controls.append(edit, remove); row.append(controls); return row;
  };

  const addFact = (category: string) => {
    const form = el('form', 'add-fact');
    const key = document.createElement('input'); key.placeholder = 'Fact name'; key.required = true; key.setAttribute('aria-label', 'Fact name');
    const value = document.createElement('input'); value.placeholder = 'Value'; value.required = true; value.setAttribute('aria-label', 'Fact value');
    const save = el('button', 'button', 'Save fact'); save.type = 'submit';
    form.append(key, value, save); facts.querySelector(`.fact-group:nth-of-type(${categories.indexOf(category) + 1})`)?.append(form);
    key.focus();
    form.onsubmit = async (event) => {
      event.preventDefault();
      try {
        await request<ContextItem>('/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          type: category === 'preferences' ? 'preference' : 'fact', category, key: key.value.trim(), value: value.value.trim(), scope: 'persistent',
        }) }); tell('Fact added.'); await load();
      } catch (error) { tell(error instanceof Error ? error.message : 'Could not add fact.', true); }
    };
  };

  const renderDocuments = () => {
    docs.replaceChildren(el('h2', undefined, 'Documents'));
    docs.append(el('p', 'section-copy', 'Upload a résumé or reference document. Swara adds readable sections to your personal context.'));
    const drop = el('div', 'drop-zone'); drop.tabIndex = 0;
    drop.append(el('strong', undefined, 'Drop PDF, PNG, or JPEG here'), el('span', undefined, 'or choose a file · 20 MB max'));
    const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.accept = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg'; input.hidden = true;
    drop.onclick = () => input.click(); drop.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') input.click(); };
    drop.ondragover = (event) => { event.preventDefault(); drop.classList.add('drop-zone--active'); };
    drop.ondragleave = () => drop.classList.remove('drop-zone--active');
    drop.ondrop = (event) => { event.preventDefault(); drop.classList.remove('drop-zone--active'); void uploadFiles(event.dataTransfer?.files); };
    input.onchange = () => { void uploadFiles(input.files); input.value = ''; }; docs.append(drop, input);
    const list = el('div', 'document-list');
    if (!documents.length) list.append(el('p', 'empty', 'No documents uploaded.'));
    documents.forEach((document) => {
      const row = el('article', 'document-row'); const copy = el('div');
      const top = el('div', 'document-title'); top.append(el('strong', undefined, document.filename), badge(document.status, 'status')); copy.append(top);
      copy.append(el('p', 'document-meta', `${document.contextItemsCreated} context ${document.contextItemsCreated === 1 ? 'item' : 'items'} · ${displayDate(document.createdAt)}`));
      if (document.status === 'failed' && document.error) copy.append(el('p', 'document-error', document.error));
      const remove = el('button', 'text-button text-button--danger', 'Delete'); remove.type = 'button';
      remove.onclick = async () => { if (!confirm(`Delete ${document.filename} and its derived context?`)) return; try { await request<void>(`/documents/${encodeURIComponent(document.id)}`, { method: 'DELETE' }); tell('Document deleted.'); await load(); } catch (error) { tell(error instanceof Error ? error.message : 'Could not delete document.', true); } };
      row.append(copy, remove); list.append(row);
    }); docs.append(list);
  };

  const fileError = (file: File): string | null => {
    const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!allowedDocumentExtensions.includes(extension)) return `${file.name}: only PDF, PNG, and JPEG files are supported.`;
    if (file.size > maxDocumentBytes) return `${file.name}: documents must be 20 MB or smaller.`;
    return null;
  };

  const queueUpload = async (file: File): Promise<void> => {
    const data = new FormData(); data.append('file', file, file.name);
    const row = await request<DocumentRow>('/documents/upload', { method: 'POST', body: data });
    documents = [row, ...documents]; renderDocuments();
    if (pollTimer === undefined) pollTimer = window.setInterval(() => void refreshDocuments(), 2_000);
  };

  const uploadFiles = async (fileList?: FileList | null) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const invalid = files.map(fileError).filter((message): message is string => Boolean(message));
    const accepted = files.filter((file) => !fileError(file));
    if (invalid.length) tell(invalid.join(' '), true);
    if (!accepted.length) return;
    // Start all accepted requests immediately, rather than serialising slow
    // storage writes. Each completed request independently enters the poller.
    const results = await Promise.allSettled(accepted.map(queueUpload));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    if (failures.length) tell(failures.join(' '), true);
    else tell(`${accepted.length} ${accepted.length === 1 ? 'document is' : 'documents are'} queued for OCR.`);
  };

  const renderActivity = () => {
    activity.replaceChildren(el('h2', undefined, 'Recent activity'));
    const list = el('div', 'activity-list');
    if (!activityItems.length) list.append(el('p', 'empty', 'No recent vault activity.'));
    activityItems.forEach((item) => {
      const row = el('article', 'activity-row'); const top = el('div', 'activity-top'); top.append(badge(item.event, 'status'), badge(item.type), item.scope ? badge(item.scope, 'scope') : document.createTextNode('')); row.append(top, el('strong', undefined, item.key));
      const value = el('p', 'activity-value', item.value); row.append(value, el('time', undefined, displayDate(item.updatedAt)));
      if (item.event === 'superseded') void correction(row, item);
      list.append(row);
    }); activity.append(list);
  };

  const correction = async (row: HTMLElement, item: Activity) => {
    try {
      const history = await request<ContextItem[]>(`/context/history?key=${encodeURIComponent(item.key)}`);
      const index = history.findIndex((version) => version.id === item.id);
      const after = history[index + 1];
      if (after) row.append(el('p', 'correction', `Corrected: ${item.value} → ${after.value}`));
    } catch { /* activity remains useful without optional history detail */ }
  };

  const header = el('header', 'vault-header');
  const heading = el('div'); heading.append(el('p', 'eyebrow', 'Personal context'), el('h1', undefined, 'Your vault'));
  header.append(heading, el('p', 'header-copy', 'What Swara can remember')); app.append(header, notice, facts, docs, activity); root.append(app);
  void load();
}
