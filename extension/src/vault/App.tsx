import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { API_BASE_URL } from '../sidepanel/api';

type ContextItem = {
  id?: string;
  type: 'fact' | 'document' | 'preference' | 'correction' | 'instruction';
  category?: string | null;
  key: string;
  value: string;
  scope: 'persistent' | 'session' | 'task';
  supersededBy?: string | null;
  documentId?: string | null;
};

type DocumentRow = {
  id: string;
  filename: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  createdAt?: string | null;
  contextItemsCreated: number;
  error?: string | null;
};

type Activity = {
  id: string;
  event: 'created' | 'updated' | 'superseded';
  key: string;
  value: string;
  type: ContextItem['type'];
  scope?: ContextItem['scope'];
  updatedAt?: string | null;
};

const categories = ['identity', 'education', 'experience', 'preferences'];

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, options);
  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
    try {
      const body = await response.json() as { detail?: string; message?: string };
      if (body.detail) detail = body.detail;
      else if (body.message) detail = body.message;
    } catch { /* use status text */ }
    throw new Error(detail);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function displayDate(value?: string | null) {
  if (!value) return 'Just now';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function timeAgo(dateString?: string | null): string {
  if (!dateString) return 'just now';
  const now = new Date();
  const date = new Date(dateString);
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (Number.isNaN(seconds) || seconds < 0) return 'just now';

  const intervals = {
    year: 31536000,
    month: 2592000,
    week: 604800,
    day: 86400,
    hour: 3600,
    minute: 60,
    second: 1
  };

  for (const [unit, value] of Object.entries(intervals)) {
    const count = Math.floor(seconds / value);
    if (count >= 1) {
      return `${count} ${unit}${count > 1 ? 's' : ''} ago`;
    }
  }
  return 'just now';
}

const Notice: React.FC<{
  message: string;
  type: 'success' | 'error';
  onDismiss: () => void;
}> = ({ message, type, onDismiss }) => {
  return (
    <div className={`notice-banner notice-banner--${type}`} role="alert">
      <div className="notice-message">{message}</div>
      <button
        type="button"
        className="notice-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss message"
      >
        ✕
      </button>
    </div>
  );
};

const FactRow: React.FC<{
  item: ContextItem;
  onSave: (item: ContextItem, newValue: string) => Promise<void>;
  onDelete: (item: ContextItem) => Promise<void>;
}> = ({ item, onSave, onDelete }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(item.value);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const handleSave = async () => {
    if (!editValue.trim()) return;
    if (editValue.trim() === item.value) {
      setIsEditing(false);
      return;
    }
    setIsSaving(true);
    try {
      await onSave(item, editValue.trim());
      setIsEditing(false);
    } catch {
      // Handled by parent notice
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    setIsSaving(true);
    try {
      await onDelete(item);
    } catch {
      // Handled by parent notice
    } finally {
      setIsSaving(false);
      setDeleteConfirm(false);
    }
  };

  return (
    <article className="fact-row-card">
      <div className="fact-row-header">
        <div className="fact-row-meta">
          <strong className="fact-row-key">{item.key}</strong>
          <span className={`badge badge--type badge--${item.type}`}>{item.type}</span>
          <span className={`badge badge--scope badge--${item.scope}`}>{item.scope}</span>
        </div>

        <div className="fact-row-actions">
          {isEditing ? (
            <>
              <button
                type="button"
                className="text-button text-button--success"
                onClick={handleSave}
                disabled={isSaving}
              >
                {isSaving ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                className="text-button text-button--muted"
                onClick={() => {
                  setIsEditing(false);
                  setEditValue(item.value);
                }}
                disabled={isSaving}
              >
                Cancel
              </button>
            </>
          ) : deleteConfirm ? (
            <span className="inline-confirm">
              Delete? ·{' '}
              <button
                type="button"
                className="text-button text-button--danger text-button--bold"
                onClick={handleDelete}
                disabled={isSaving}
              >
                Yes
              </button>{' '}
              /{' '}
              <button
                type="button"
                className="text-button text-button--muted"
                onClick={() => setDeleteConfirm(false)}
                disabled={isSaving}
              >
                Cancel
              </button>
            </span>
          ) : (
            <>
              <button
                type="button"
                className="text-button"
                onClick={() => setIsEditing(true)}
              >
                Edit
              </button>
              <button
                type="button"
                className="text-button text-button--danger"
                onClick={() => setDeleteConfirm(true)}
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      <div className="fact-row-content">
        {isEditing ? (
          <input
            type="text"
            className="fact-edit-input"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
              if (e.key === 'Escape') {
                setIsEditing(false);
                setEditValue(item.value);
              }
            }}
            autoFocus
            aria-label={`Edit value for ${item.key}`}
          />
        ) : (
          <p className="fact-value">{item.value}</p>
        )}
      </div>
    </article>
  );
};

const CategorySection: React.FC<{
  title: string;
  items: ContextItem[];
  guidanceText: string;
  onAddFact: (category: string, key: string, value: string) => Promise<void>;
  onSaveFact: (item: ContextItem, newValue: string) => Promise<void>;
  onDeleteFact: (item: ContextItem) => Promise<void>;
}> = ({ title, items, guidanceText, onAddFact, onSaveFact, onDeleteFact }) => {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKey.trim() || !newValue.trim()) return;
    setIsSubmitting(true);
    try {
      await onAddFact(title, newKey.trim(), newValue.trim());
      setNewKey('');
      setNewValue('');
      setShowAddForm(false);
    } catch {
      // Parent displays notice
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="category-group">
      <div className="category-header">
        <h3 className="category-title">{title}</h3>
        {!showAddForm && (
          <button
            type="button"
            className="text-button text-button--accent"
            onClick={() => setShowAddForm(true)}
          >
            Add fact
          </button>
        )}
      </div>

      {showAddForm && (
        <form onSubmit={handleAddSubmit} className="add-fact-form">
          <input
            type="text"
            className="add-fact-input"
            placeholder="Fact name (e.g. Email Address)"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            required
            disabled={isSubmitting}
            aria-label="New fact name"
          />
          <input
            type="text"
            className="add-fact-input"
            placeholder="Value (e.g. alex@example.com)"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            required
            disabled={isSubmitting}
            aria-label="New fact value"
          />
          <div className="add-fact-actions">
            <button type="submit" className="button" disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : 'Save fact'}
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setShowAddForm(false);
                setNewKey('');
                setNewValue('');
              }}
              disabled={isSubmitting}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="category-items">
        {items.length === 0 ? (
          <p className="empty-guidance">{guidanceText}</p>
        ) : (
          items.map((item) => (
            <FactRow
              key={item.id || item.key}
              item={item}
              onSave={onSaveFact}
              onDelete={onDeleteFact}
            />
          ))
        )}
      </div>
    </div>
  );
};

const OtherSection: React.FC<{
  items: ContextItem[];
  onSaveFact: (item: ContextItem, newValue: string) => Promise<void>;
  onDeleteFact: (item: ContextItem) => Promise<void>;
}> = ({ items, onSaveFact, onDeleteFact }) => {
  if (items.length === 0) return null;

  return (
    <div className="category-group">
      <div className="category-header">
        <h3 className="category-title">Other</h3>
      </div>

      <div className="category-items">
        {items.map((item) => (
          <FactRow
            key={item.id || item.key}
            item={item}
            onSave={onSaveFact}
            onDelete={onDeleteFact}
          />
        ))}
      </div>
    </div>
  );
};

const DocumentRowComponent: React.FC<{
  document: DocumentRow;
  contextItems: ContextItem[];
  onDelete: (docId: string) => Promise<void>;
}> = ({ document, contextItems, onDelete }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Everything OCR pulled out of this file. It stays out of the profile and
  // lives here instead — the server sends `documentId` on each derived item.
  const docItems = contextItems.filter(
    (item) => item.type === 'document' && item.documentId === document.id,
  );

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDeleting(true);
    try {
      await onDelete(document.id);
    } catch {
      setIsDeleting(false);
    }
  };

  const cleanKey = (key: string) => {
    const parts = key.split(':');
    if (parts.length > 2) {
      return parts.slice(2).join(':').replace(/_/g, ' ');
    }
    return key;
  };

  return (
    <div
      className={`document-card ${isExpanded ? 'document-card--expanded' : ''}`}
      role="button"
      tabIndex={0}
      aria-expanded={isExpanded}
      aria-label={`${document.filename}, ${docItems.length} extracted details`}
      onClick={() => setIsExpanded(!isExpanded)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setIsExpanded(!isExpanded);
        }
      }}
    >
      <div className="document-card-header">
        <div className="document-card-info">
          <div className="document-card-title">
            <span className="document-card-filename">{document.filename}</span>
            <span className={`badge badge--status badge--${document.status}`}>
              {document.status}
            </span>
          </div>
          <div className="document-card-meta">
            <span className="tabular">{docItems.length}</span> details extracted
            {document.createdAt && (
              <>
                {' · '}
                <span>{displayDate(document.createdAt)}</span>
              </>
            )}
          </div>
        </div>

        <div className="document-card-actions" onClick={(e) => e.stopPropagation()}>
          {deleteConfirm ? (
            <span className="inline-confirm warning-confirm">
              Delete doc & derived facts? ·{' '}
              <button
                type="button"
                className="text-button text-button--danger text-button--bold"
                onClick={handleDelete}
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Yes'}
              </button>{' '}
              /{' '}
              <button
                type="button"
                className="text-button text-button--muted"
                onClick={() => setDeleteConfirm(false)}
                disabled={isDeleting}
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="text-button text-button--danger"
              onClick={() => setDeleteConfirm(true)}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {document.status === 'failed' && document.error && (
        <div className="document-card-error">
          Error: {document.error}
        </div>
      )}

      {isExpanded && (
        <div className="document-card-disclosure" onClick={(e) => e.stopPropagation()}>
          {docItems.length === 0 ? (
            <p className="empty-subtext">
              {document.status === 'pending' || document.status === 'processing'
                ? 'Processing document text and extracting details...'
                : 'No details were extracted from this document.'}
            </p>
          ) : (
            <div className="document-derived-list">
              {docItems.map((item) => (
                <div key={item.id || item.key} className="document-derived-item">
                  <div className="derived-item-header">
                    <span className="derived-item-key">{cleanKey(item.key)}</span>
                    <span className="badge badge--scope">{item.scope}</span>
                  </div>
                  <p className="derived-item-value">{item.value}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const ActivityRowComponent: React.FC<{
  activity: Activity;
}> = ({ activity }) => {
  const [history, setHistory] = useState<ContextItem[] | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  useEffect(() => {
    if (activity.event !== 'superseded') return;

    let isMounted = true;
    const fetchHistory = async () => {
      setIsLoadingHistory(true);
      try {
        const data = await request<ContextItem[]>(`/context/history?key=${encodeURIComponent(activity.key)}`);
        if (isMounted) {
          setHistory(data);
        }
      } catch {
        // Fail silently per instructions
      } finally {
        if (isMounted) {
          setIsLoadingHistory(false);
        }
      }
    };

    fetchHistory();
    return () => {
      isMounted = false;
    };
  }, [activity.event, activity.key]);

  const renderCorrection = () => {
    if (!history) return null;
    const index = history.findIndex(version => version.id === activity.id);
    if (index === -1) return null;
    const after = history[index + 1];
    if (!after) return null;

    return (
      <div className="activity-correction">
        <span className="correction-label">Corrected:</span>{' '}
        <span className="value-old">{activity.value}</span>{' '}
        <span className="arrow">→</span>{' '}
        <span className="value-new">{after.value}</span>
      </div>
    );
  };

  return (
    <div className="activity-item">
      <div className="activity-item-header">
        <div className="activity-item-meta">
          <span className={`badge badge--event badge--${activity.event}`}>{activity.event}</span>
          <span className={`badge badge--type badge--${activity.type}`}>{activity.type}</span>
          {activity.scope && (
            <span className={`badge badge--scope badge--${activity.scope}`}>{activity.scope}</span>
          )}
        </div>
        <time className="activity-item-time">{displayDate(activity.updatedAt)}</time>
      </div>

      <div className="activity-item-title">
        <strong>{activity.key}</strong>
      </div>
      <p className="activity-item-value">{activity.value}</p>

      {activity.event === 'superseded' && renderCorrection()}
    </div>
  );
};

const App: React.FC = () => {
  const [context, setContext] = useState<ContextItem[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [activityItems, setActivityItems] = useState<Activity[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [notice, setNotice] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Drag and drop state
  const [isDragActive, setIsDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const [ctx, docs, act] = await Promise.all([
        request<ContextItem[]>('/context'),
        request<DocumentRow[]>('/documents'),
        request<Activity[]>('/activity?limit=50'),
      ]);
      setContext(ctx);
      setDocuments(docs);
      setActivityItems(act);
    } catch (error) {
      setNotice({
        message: error instanceof Error ? error.message : 'Could not load the vault.',
        type: 'error',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Poll only while OCR is actually running. Each document is polled on its
  // own endpoint so concurrent jobs stay independent, and the whole vault is
  // reloaded once at the end to pick up the context items OCR produced.
  useEffect(() => {
    const inFlight = documents.filter(
      (doc) => doc.status === 'pending' || doc.status === 'processing',
    );
    if (inFlight.length === 0) return;

    let cancelled = false;
    const intervalId = setInterval(async () => {
      try {
        const refreshed = await Promise.all(
          inFlight.map((doc) =>
            request<DocumentRow>(`/documents/${encodeURIComponent(doc.id)}`),
          ),
        );
        if (cancelled) return;

        const byId = new Map(refreshed.map((doc) => [doc.id, doc]));
        setDocuments((prevDocs) => prevDocs.map((doc) => byId.get(doc.id) ?? doc));
        const settled = refreshed.every(
          (doc) => doc.status !== 'pending' && doc.status !== 'processing',
        );
        if (settled) load();
      } catch (err) {
        if (cancelled) return;
        setNotice({
          message: err instanceof Error ? err.message : 'Could not check document status.',
          type: 'error',
        });
      }
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [documents]);

  const handleSaveFact = async (item: ContextItem, newValue: string) => {
    if (!item.id) return;
    try {
      await request<ContextItem>(`/context/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: newValue }),
      });
      setNotice({ message: 'Fact updated.', type: 'success' });
      await load();
    } catch (error) {
      setNotice({
        message: error instanceof Error ? error.message : 'Could not update fact.',
        type: 'error',
      });
      throw error;
    }
  };

  const handleDeleteFact = async (item: ContextItem) => {
    if (!item.id) return;
    try {
      await request<void>(`/context/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
      });
      setNotice({ message: 'Fact deleted.', type: 'success' });
      await load();
    } catch (error) {
      setNotice({
        message: error instanceof Error ? error.message : 'Could not delete fact.',
        type: 'error',
      });
      throw error;
    }
  };

  const handleAddFact = async (category: string, key: string, value: string) => {
    try {
      await request<ContextItem>('/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: category === 'preferences' ? 'preference' : 'fact',
          category,
          key,
          value,
          scope: 'persistent',
        }),
      });
      setNotice({ message: 'Fact added.', type: 'success' });
      await load();
    } catch (error) {
      setNotice({
        message: error instanceof Error ? error.message : 'Could not add fact.',
        type: 'error',
      });
      throw error;
    }
  };

  const handleDeleteDocument = async (docId: string) => {
    try {
      await request<void>(`/documents/${encodeURIComponent(docId)}`, {
        method: 'DELETE',
      });
      setNotice({ message: 'Document and derived context deleted.', type: 'success' });
      await load();
    } catch (error) {
      setNotice({
        message: error instanceof Error ? error.message : 'Could not delete document.',
        type: 'error',
      });
      throw error;
    }
  };

  // Document Drag and Drop
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setIsDragActive(true);
    } else if (e.type === "dragleave") {
      setIsDragActive(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await uploadFiles(e.dataTransfer.files);
    }
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await uploadFiles(e.target.files);
      e.target.value = '';
    }
  };

  const fileError = (file: File): string | null => {
    const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    const allowedDocumentExtensions = ['.pdf', '.png', '.jpg', '.jpeg', '.zip'];
    const maxDocumentBytes = 20 * 1024 * 1024;

    if (!allowedDocumentExtensions.includes(extension)) {
      return `${file.name}: Only PDF, PNG, JPEG, and ZIP files are supported.`;
    }
    if (file.size > maxDocumentBytes) {
      return `${file.name}: Documents must be 20 MB or smaller.`;
    }
    return null;
  };

  const uploadFiles = async (filesList: FileList | null) => {
    const files = Array.from(filesList || []);
    if (!files.length) return;

    const invalid = files.map(fileError).filter((msg): msg is string => msg !== null);
    const accepted = files.filter((f) => fileError(f) === null);

    if (invalid.length) {
      setNotice({ message: invalid.join(' '), type: 'error' });
    }
    if (!accepted.length) return;

    setNotice({ message: `Uploading ${accepted.length} file(s)...`, type: 'success' });

    const results = await Promise.allSettled(
      accepted.map(async (file) => {
        const data = new FormData();
        data.append('file', file, file.name);
        return request<DocumentRow>('/documents/upload', {
          method: 'POST',
          body: data,
        });
      })
    );

    const newDocs: DocumentRow[] = [];
    const failures: string[] = [];

    results.forEach((res) => {
      if (res.status === 'fulfilled') {
        newDocs.push(res.value);
      } else {
        failures.push(res.reason instanceof Error ? res.reason.message : String(res.reason));
      }
    });

    if (newDocs.length > 0) {
      setDocuments(prev => [...newDocs, ...prev]);
    }

    if (failures.length > 0) {
      setNotice({ message: failures.join(' '), type: 'error' });
    } else {
      setNotice({
        message: `Successfully uploaded ${accepted.length} document${accepted.length > 1 ? 's' : ''} for OCR processing.`,
        type: 'success'
      });
    }
  };

  // Filtering for curated Profile view
  const getCategoryItems = (category: string) => {
    return context.filter(
      (item) =>
        (item.category || '').toLowerCase() === category &&
        item.type !== 'document' &&
        !item.supersededBy
    );
  };

  const getUngroupedItems = () => {
    return context.filter(
      (item) =>
        !categories.includes((item.category || '').toLowerCase()) &&
        item.type !== 'document' &&
        !item.supersededBy
    );
  };

  const curatedFactsCount = context.filter(
    (item) => item.type !== 'document' && !item.supersededBy
  ).length;

  const getLatestUpdateText = () => {
    let latestDate: Date | null = null;

    for (const item of activityItems) {
      if (item.updatedAt) {
        const d = new Date(item.updatedAt);
        if (!Number.isNaN(d.valueOf()) && (latestDate === null || d.getTime() > latestDate.getTime())) {
          latestDate = d;
        }
      }
    }

    for (const doc of documents) {
      if (doc.createdAt) {
        const d = new Date(doc.createdAt);
        if (!Number.isNaN(d.valueOf()) && (latestDate === null || d.getTime() > latestDate.getTime())) {
          latestDate = d;
        }
      }
    }

    if (latestDate === null) return 'recently';
    return timeAgo(latestDate.toISOString());
  };

  const guidanceTexts: Record<string, string> = {
    identity: 'No identity details saved yet. Add key details like your name or contact info.',
    education: 'No education history saved yet. Add details about your degrees or certifications.',
    experience: 'No professional experience saved yet. Add details about your past roles or skills.',
    preferences: 'No preferences saved yet. Add details about your job search preferences or requirements.'
  };

  return (
    <div className="vault-container">
      <header className="vault-header">
        <div className="vault-brand">
          <div className="vault-brand-eyebrow">Personal context</div>
          <h1 className="vault-title">Your Vault</h1>
          <p className="vault-subtitle">What Swara can remember to fill your forms</p>
        </div>

        {!isLoading && (
          <div className="summary-strip">
            <span className="summary-item"><span className="tabular">{curatedFactsCount}</span> facts</span>
            <span className="summary-dot">·</span>
            <span className="summary-item"><span className="tabular">{documents.length}</span> documents</span>
            <span className="summary-dot">·</span>
            <span className="summary-item">updated {getLatestUpdateText()}</span>
          </div>
        )}
      </header>

      {notice && (
        <Notice
          message={notice.message}
          type={notice.type}
          onDismiss={() => setNotice(null)}
        />
      )}

      {isLoading ? (
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading personal vault...</p>
        </div>
      ) : (
        <div className="vault-grid">
          {/* Profile Section (Left Column) */}
          <section className="vault-column profile-section">
            <div className="column-header">
              <h2>Profile</h2>
              <p className="section-description">
                Curated facts and preferences available for auto-filling web forms.
              </p>
            </div>

            <div className="categories-list">
              {categories.map((cat) => (
                <CategorySection
                  key={cat}
                  title={cat}
                  items={getCategoryItems(cat)}
                  guidanceText={guidanceTexts[cat]}
                  onAddFact={handleAddFact}
                  onSaveFact={handleSaveFact}
                  onDeleteFact={handleDeleteFact}
                />
              ))}

              <OtherSection
                items={getUngroupedItems()}
                onSaveFact={handleSaveFact}
                onDeleteFact={handleDeleteFact}
              />
            </div>
          </section>

          {/* Sidebar Section (Right Column) */}
          <div className="vault-column sidebar-column">
            {/* Documents Section */}
            <section className="documents-section card-panel">
              <div className="panel-header">
                <h2>Documents</h2>
                <p className="section-description">
                  Upload a resume or reference file to extract structured context.
                </p>
              </div>

              {/* Drag and Drop Zone */}
              <div
                className={`drop-zone ${isDragActive ? 'drop-zone--active' : ''}`}
                onDragEnter={handleDrag}
                onDragOver={handleDrag}
                onDragLeave={handleDrag}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label="Upload files by dragging here or clicking to choose"
              >
                <input
                  type="file"
                  multiple
                  accept=".pdf,.png,.jpg,.jpeg,.zip,application/pdf,image/png,image/jpeg,application/zip"
                  className="hidden-file-input"
                  ref={fileInputRef}
                  onChange={handleFileInputChange}
                />
                <strong>Drop files here</strong>
                <span className="drop-zone-sub">or click to browse · 20 MB max</span>
              </div>

              <div className="documents-list">
                {documents.length === 0 ? (
                  <div className="empty-card">
                    <p className="empty-text">No documents uploaded yet.</p>
                    <p className="empty-subtext">Add files to derive automated context.</p>
                  </div>
                ) : (
                  documents.map((doc) => (
                    <DocumentRowComponent
                      key={doc.id}
                      document={doc}
                      contextItems={context}
                      onDelete={handleDeleteDocument}
                    />
                  ))
                )}
              </div>
            </section>

            {/* Activity Feed Section */}
            <section className="activity-section card-panel">
              <div className="panel-header">
                <h2>Recent Activity</h2>
                <p className="section-description">
                  History of modifications and auto-derived updates.
                </p>
              </div>

              <div className="activity-list">
                {activityItems.length === 0 ? (
                  <div className="empty-card">
                    <p className="empty-text">No activity recorded yet.</p>
                  </div>
                ) : (
                  activityItems.map((act) => (
                    <ActivityRowComponent key={act.id} activity={act} />
                  ))
                )}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
};

export function mountVault(root: HTMLElement) {
  root.className = 'vault-root';
  const reactRoot = createRoot(root);
  reactRoot.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
