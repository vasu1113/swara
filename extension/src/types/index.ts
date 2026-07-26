/**
 * Shared contract types for Swara.
 *
 * This file is the single source of truth for the extension side. The server
 * mirrors it in `server/schemas.py` — change both together or the two halves
 * silently disagree.
 */

/* ------------------------------------------------------------------ *
 * Page / form extraction (content script -> side panel -> server)
 * ------------------------------------------------------------------ */

export type FieldType = 'text' | 'textarea' | 'select' | 'checkbox' | 'radio';

export type FieldOption = {
  /** The value actually submitted, i.e. the element's `value` attribute. */
  value: string;
  /** Human-readable option text, for the LLM to reason over. */
  label: string;
};

export type FormField = {
  /**
   * Stable identifier the executor uses to find this element again.
   * Derivation order: element `id` -> element `name` -> `<tag>:<index>`.
   * Radio and checkbox groups share one id (their common `name`).
   */
  fieldId: string;
  /** Cleaned label text, with asterisks/aria-hidden/hint nodes stripped. */
  label: string;
  /**
   * The semantic question being asked. Usually the label; for radio and
   * checkbox groups it is the `<fieldset><legend>` text, since the individual
   * `<label>`s belong to the options, not the question.
   */
  question: string;
  type: FieldType;
  required: boolean;
  /** Populated for select, radio, and checkbox-group fields. Empty otherwise. */
  options: FieldOption[];
  placeholder?: string;
  maxLength?: number;
  /** Whatever is already in the field, so the planner can avoid clobbering it. */
  currentValue?: string;
};

export type PageControl = {
  /** Stable identifier the executor uses to find this control again. */
  controlId: string;
  /** Cleaned visible text, with accessible fallbacks when it has none. */
  label: string;
  role: 'button' | 'link' | 'tab' | 'submit';
  disabled: boolean;
};

export type PageContext = {
  url: string;
  title: string;
  /** The page's main heading, e.g. the job title. Useful planner context. */
  heading?: string;
  fields: FormField[];
  controls: PageControl[];
};

/* ------------------------------------------------------------------ *
 * Actions (server -> side panel -> content script)
 * ------------------------------------------------------------------ */

export type ActionType =
  | 'fill'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'clear'
  | 'click'
  | 'scroll_to';

export type Action = {
  fieldId: string;
  action: ActionType;
  /**
   * For `fill`: the literal text. For `select`/`check`/`uncheck`: the option
   * `value` to act on. For `clear`: ignored.
   */
  value: string;
  /** Short human-readable justification, shown in the preview UI. */
  reasoning?: string;
};

export type ActionResult = {
  fieldId: string;
  ok: boolean;
  error?: string;
};

/* ------------------------------------------------------------------ *
 * Memory classification — the product's differentiator
 * ------------------------------------------------------------------ */

/**
 * `fact`        — a durable truth about the user ("I worked at HyperVerge")
 * `correction`  — supersedes an existing fact ("2026, not 2025")
 * `preference`  — how they want output written ("keep it concise")
 * `instruction` — a constraint on this task only ("don't mention my startup")
 */
export type MemoryType = 'fact' | 'correction' | 'preference' | 'instruction';

export type MemoryScope = 'persistent' | 'session' | 'task';

export type MemoryUpdate = {
  type: MemoryType;
  key: string;
  value: string;
  /** Set on corrections: what this replaces. */
  oldValue?: string;
  scope: MemoryScope;
  /** Why the classifier chose this type/scope. Surfaced in the UI. */
  reason: string;
};

/* ------------------------------------------------------------------ *
 * Planning
 * ------------------------------------------------------------------ */

/** A context item the planner considered, for transparency in the UI. */
export type ContextUsage = {
  key: string;
  summary: string;
  /** Why it was used, or why it was ruled out. */
  reason: string;
};

export type PlanRequest = {
  sessionId: string;
  page: PageContext;
  /** The user's instruction, whether typed or transcribed from speech. */
  instruction: string;
};

/**
 * Sent once the user accepts a plan. Memory is committed on confirmation, not
 * at plan time — the preview promises what will be remembered, so nothing is
 * written until the user agrees.
 */
export type MemoryApplyRequest = {
  sessionId: string;
  memoryUpdates: MemoryUpdate[];
};

export type PlanResponse = {
  status: 'ready' | 'needs_clarification';
  actions: Action[];
  clarifications: string[];
  memoryUpdates: MemoryUpdate[];
  /** Fields the planner deliberately left alone, with a reason. */
  unresolved: string[];
  relevantContext: ContextUsage[];
  excludedContext: ContextUsage[];
  /** One or two sentences suitable for reading aloud over TTS. */
  spokenSummary: string;
};

/* ------------------------------------------------------------------ *
 * Voice
 * ------------------------------------------------------------------ */

/** Sarvam language codes. "unknown" lets Saarika auto-detect code-switching. */
export type SarvamLanguage =
  | 'unknown'
  | 'en-IN'
  | 'hi-IN'
  | 'ta-IN'
  | 'te-IN'
  | 'kn-IN'
  | 'ml-IN'
  | 'mr-IN'
  | 'bn-IN'
  | 'gu-IN'
  | 'pa-IN'
  | 'od-IN';

export type TranscriptResponse = {
  transcript: string;
  /** What Saarika reported detecting, when it says. */
  language?: string;
};

export type SpeechRequest = {
  text: string;
  /** Always send one explicitly — leaving it unset skews pronunciation. */
  language: SarvamLanguage;
};

export type SpeechResponse = {
  /** base64-encoded audio, ready for a data: URL. */
  audioBase64: string;
  mimeType: string;
};

/* ------------------------------------------------------------------ *
 * Extension-internal messaging
 * ------------------------------------------------------------------ */

export type SwaraPingMessage = { type: 'SWARA_PING' };
export type SwaraPongMessage = {
  type: 'SWARA_PONG';
  url: string;
  title: string;
};
export type SwaraExtractMessage = { type: 'SWARA_EXTRACT' };
export type SwaraExtractResultMessage = {
  type: 'SWARA_EXTRACT_RESULT';
  page: PageContext;
};
export type SwaraExecuteMessage = {
  type: 'SWARA_EXECUTE';
  actions: Action[];
};
export type SwaraExecuteResultMessage = {
  type: 'SWARA_EXECUTE_RESULT';
  results: ActionResult[];
};

export type SwaraMessage =
  | SwaraPingMessage
  | SwaraPongMessage
  | SwaraExtractMessage
  | SwaraExtractResultMessage
  | SwaraExecuteMessage
  | SwaraExecuteResultMessage;
