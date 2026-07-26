import { FormEvent, useEffect, useRef, useState } from 'react';
import { API_BASE_URL } from './api';
import {
  AUDIO_SAMPLE_RATE,
  SESSION_PATH,
  type AgentState,
  type ClientMessage,
  type ServerMessage,
} from '../types/session';
import type {
  Action,
  ActionResult,
  ContextUsage,
  MemoryUpdate,
  PageContext,
  SwaraExecuteResultMessage,
  SwaraExtractResultMessage,
  SwaraMessage,
} from '../types';

type ConversationItem =
  | { id: string; kind: 'user' | 'agent'; text: string }
  | { id: string; kind: 'actions'; actions: Action[]; results?: ActionResult[] }
  | { id: string; kind: 'memory'; updates: MemoryUpdate[] };

type ContextPanel = { relevant: ContextUsage[]; excluded: ContextUsage[] };
type PlaybackChunk = { data: string; mimeType: string };

const MP3_MIME = 'audio/mpeg';
const PCM_MIME = 'audio/pcm';

/**
 * Plays raw 16 kHz PCM chunks gaplessly through Web Audio.
 *
 * Pipecat emits raw PCM rather than MP3, which MediaSource cannot accept. Each
 * chunk is scheduled against a running cursor rather than played on arrival,
 * so consecutive chunks butt up against each other instead of leaving audible
 * seams between them.
 */
class PcmPlayer {
  private ctx: AudioContext | null = null;
  private cursor = 0;
  private sources = new Set<AudioBufferSourceNode>();

  push(bytes: Uint8Array) {
    if (!this.ctx) this.ctx = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
    const ctx = this.ctx;
    const samples = new Int16Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    if (!samples.length) return;

    const buffer = ctx.createBuffer(1, samples.length, AUDIO_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i] / 0x8000;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    // A small lead keeps scheduling ahead of playback when chunks arrive late.
    const startAt = Math.max(ctx.currentTime + 0.02, this.cursor);
    source.start(startAt);
    this.cursor = startAt + buffer.duration;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  stop() {
    for (const source of this.sources) {
      try { source.stop(); } catch { /* already ended */ }
    }
    this.sources.clear();
    this.cursor = 0;
  }
}

/** Swallow the DOM exceptions MediaSource throws on races we can't prevent. */
function with_suppress(fn: () => void) {
  try { fn(); } catch { /* stream already torn down */ }
}

const makeSessionId = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `swara-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const sessionUrl = () => `${API_BASE_URL.replace(/^http/, 'ws')}${SESSION_PATH}`;

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
  return result?.type === 'SWARA_EXTRACT_RESULT' && isPageContext(result.page) ? result.page : null;
}

function extractResults(value: unknown): ActionResult[] | null {
  if (Array.isArray(value)) return value as ActionResult[];
  const result = value as Partial<SwaraExecuteResultMessage> | null;
  return result?.type === 'SWARA_EXECUTE_RESULT' && Array.isArray(result.results) ? result.results : null;
}

function contentScriptError(message?: string): string {
  if (message?.toLowerCase().includes('receiving end')) {
    return 'Could not reach this page. Reload the tab, then try Swara again.';
  }
  return message ?? 'Could not reach this page. Reload the tab, then try Swara again.';
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

async function openPermissionPage(): Promise<string | null> {
  const url = chrome.runtime.getURL('src/permission/index.html');
  try {
    await chrome.tabs.create({ url });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : `Could not open ${url}.`;
  }
}

async function openVaultPage(): Promise<string | null> {
  const url = chrome.runtime.getURL('src/vault/index.html');
  try {
    await chrome.tabs.create({ url });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : `Could not open ${url}.`;
  }
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(parts.join(''));
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function actionSummary(actions: Action[], results?: ActionResult[]): string {
  if (!results) return `Working on ${actions.length} ${actions.length === 1 ? 'field' : 'fields'}…`;
  const completed = results.filter((result) => result.ok).length;
  return `Filled ${completed} of ${results.length} ${results.length === 1 ? 'field' : 'fields'}`;
}

function App() {
  const [sessionId] = useState(makeSessionId);
  const [agentState, setAgentState] = useState<AgentState>('idle');
  const [conversation, setConversation] = useState<ConversationItem[]>([]);
  const [partialTranscript, setPartialTranscript] = useState('');
  const [typedText, setTypedText] = useState('');
  const [context, setContext] = useState<ContextPanel>({ relevant: [], excluded: [] });
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [needsMicPermission, setNeedsMicPermission] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const playbackRef = useRef<HTMLAudioElement | null>(null);
  const playbackUrlRef = useRef<string | null>(null);
  const playbackQueueRef = useRef<PlaybackChunk[]>([]);
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const audioCompleteRef = useRef(false);
  const pcmPlayerRef = useRef<PcmPlayer>(new PcmPlayer());
  const activeActionRef = useRef<string | null>(null);
  const startingRef = useRef(false);
  const agentStateRef = useRef<AgentState>('idle');
  const mountedRef = useRef(true);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  const send = (message: ClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  const stopPlayback = () => {
    pcmPlayerRef.current.stop();
    playbackQueueRef.current = [];
    sourceBufferRef.current = null;
    mediaSourceRef.current = null;
    audioCompleteRef.current = false;
    const audio = playbackRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      playbackRef.current = null;
    }
    if (playbackUrlRef.current) {
      URL.revokeObjectURL(playbackUrlRef.current);
      playbackUrlRef.current = null;
    }
  };

  /**
   * Streams the agent's speech as it arrives.
   *
   * Two approaches were wrong before this one. An Audio element per chunk
   * stutters, because Sarvam sends MP3 frames rather than standalone files and
   * each element pays play() startup latency. Buffering the whole turn plays
   * smoothly but adds a dead pause before every reply, which is worse in
   * conversation than a little roughness.
   *
   * MediaSource gives both: append frames to one buffer as they land, so audio
   * starts on the first chunk and plays continuously.
   */
  const ensurePlaybackStream = () => {
    if (mediaSourceRef.current) return;
    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(MP3_MIME)) {
      return; // falls back to buffered playback below
    }

    const mediaSource = new MediaSource();
    const url = URL.createObjectURL(mediaSource);
    const audio = new Audio(url);
    audio.autoplay = true;
    mediaSourceRef.current = mediaSource;
    playbackRef.current = audio;
    playbackUrlRef.current = url;

    mediaSource.addEventListener('sourceopen', () => {
      if (mediaSourceRef.current !== mediaSource) return;
      try {
        const buffer = mediaSource.addSourceBuffer(MP3_MIME);
        sourceBufferRef.current = buffer;
        buffer.addEventListener('updateend', drainPlaybackQueue);
        drainPlaybackQueue();
      } catch {
        teardownPlaybackStream();
      }
    }, { once: true });

    audio.onended = () => {
      if (playbackRef.current !== audio) return;
      teardownPlaybackStream();
    };

    void audio.play().catch(() => undefined);
  };

  const drainPlaybackQueue = () => {
    const buffer = sourceBufferRef.current;
    if (!buffer || buffer.updating) return;
    const chunk = playbackQueueRef.current.shift();
    if (!chunk) {
      // Only close the stream once every queued frame has been appended.
      if (audioCompleteRef.current && mediaSourceRef.current?.readyState === 'open') {
        with_suppress(() => mediaSourceRef.current!.endOfStream());
      }
      return;
    }
    const bytes = fromBase64(chunk.data);
    with_suppress(() =>
      buffer.appendBuffer(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      ),
    );
  };

  const teardownPlaybackStream = () => {
    sourceBufferRef.current = null;
    mediaSourceRef.current = null;
    audioCompleteRef.current = false;
  };

  const stopCapture = () => {
    workletRef.current?.disconnect();
    workletRef.current = null;
    silentGainRef.current?.disconnect();
    silentGainRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    if (audioContext && audioContext.state !== 'closed') void audioContext.close();
    if (mountedRef.current) setAudioLevel(0);
  };

  const closeSession = (tellServer: boolean) => {
    startingRef.current = false;
    if (tellServer) send({ type: 'session.stop' });
    socketRef.current?.close();
    socketRef.current = null;
    stopCapture();
    stopPlayback();
    activeActionRef.current = null;
    if (mountedRef.current) {
      setSessionOpen(false);
      setAgentState('idle');
      setPartialTranscript('');
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      closeSession(true);
    };
  }, []);

  useEffect(() => {
    agentStateRef.current = agentState;
  }, [agentState]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [conversation, partialTranscript]);

  const updateActionResults = (id: string, results: ActionResult[]) => {
    setConversation((items) =>
      items.map((item) => (item.kind === 'actions' && item.id === id ? { ...item, results } : item)),
    );
  };

  const executeActions = async (actions: Action[]) => {
    const id = `actions-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    activeActionRef.current = id;
    setConversation((items) => [...items, { id, kind: 'actions', actions }]);
    setAgentState('acting');
    try {
      const response = await sendToActiveTab({ type: 'SWARA_EXECUTE', actions });
      const results = extractResults(response);
      if (!results) throw new Error('The page returned an invalid action result. Try reloading the tab.');
      updateActionResults(id, results);
      send({ type: 'action.result', results });
    } catch (actionError) {
      const failed = actions.map((action) => ({
        fieldId: action.fieldId,
        ok: false,
        error: actionError instanceof Error ? actionError.message : 'Could not complete this action.',
      }));
      updateActionResults(id, failed);
      send({ type: 'action.result', results: failed });
      setError(actionError instanceof Error ? actionError.message : 'Unable to act on this page.');
    } finally {
      activeActionRef.current = null;
    }
  };

  const handleServerMessage = (message: ServerMessage) => {
    switch (message.type) {
      case 'state':
        setAgentState(message.state);
        return;
      case 'speech.start':
        stopPlayback();
        send({ type: 'agent.interrupt' });
        return;
      case 'agent.audio.end':
        audioCompleteRef.current = true;
        drainPlaybackQueue();
        return;
      case 'speech.end':
        return;
      case 'transcript.partial':
        setPartialTranscript(message.text);
        return;
      case 'transcript.final':
        setPartialTranscript('');
        if (message.text.trim()) {
          setConversation((items) => [...items, { id: `user-${Date.now()}`, kind: 'user', text: message.text }]);
        }
        return;
      case 'agent.text':
        if (message.text.trim()) {
          setConversation((items) => [...items, { id: `agent-${Date.now()}`, kind: 'agent', text: message.text }]);
        }
        return;
      case 'agent.question':
        // The question is already inside the spoken text; rendering it again
        // showed every question twice.
        return;
      case 'agent.audio':
        if (message.mimeType.startsWith(PCM_MIME)) {
          pcmPlayerRef.current.push(fromBase64(message.data));
          return;
        }
        playbackQueueRef.current.push({ data: message.data, mimeType: message.mimeType });
        ensurePlaybackStream();
        drainPlaybackQueue();
        return;
      case 'agent.actions':
        void executeActions(message.actions);
        return;
      case 'memory.learned':
        if (message.updates.length) {
          setConversation((items) => [
            ...items,
            { id: `memory-${Date.now()}`, kind: 'memory', updates: message.updates },
          ]);
        }
        return;
      case 'context.used':
        setContext({ relevant: message.relevant, excluded: message.excluded });
        return;
      case 'error':
        setError(message.message);
        setAgentState('error');
        if (message.fatal) closeSession(false);
        return;
    }
  };

  const startCapture = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Without echo cancellation the microphone hears the agent's own
        // speech and transcribes it as the user talking, so the agent
        // interrupts and answers itself. The other two keep room noise and
        // distance from being heard as words.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: AUDIO_SAMPLE_RATE,
      },
    });
    if (!mountedRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    // Ask the browser for 16 kHz directly. Chrome resamples the microphone with
    // a proper anti-aliasing filter; doing it ourselves by interpolating
    // between samples folds everything above 8 kHz back into the speech band as
    // noise, which is heard by the recogniser as garbled consonants and
    // phantom words.
    const audioContext = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
    try {
      // Served verbatim from public/ at a stable, unhashed path. Vite's
      // `new URL('./worklet.ts', import.meta.url)` emits a content-hashed
      // asset, which MV3 then gates behind web_accessible_resources and which
      // changes name every build — a fragile dependency for something whose
      // failure silently disables the microphone.
      await audioContext.audioWorklet.addModule(chrome.runtime.getURL('worklet.js'));
      const source = audioContext.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(audioContext, 'swara-pcm-capture', {
        processorOptions: { targetSampleRate: AUDIO_SAMPLE_RATE },
      });
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      source.connect(worklet);
      worklet.connect(silentGain);
      silentGain.connect(audioContext.destination);
      worklet.port.onmessage = (event: MessageEvent<{ type: 'chunk' | 'level'; data: ArrayBuffer | number }>) => {
        if (event.data.type === 'chunk' && event.data.data instanceof ArrayBuffer) {
          send({ type: 'audio.chunk', data: toBase64(event.data.data) });
        }
        if (event.data.type === 'level' && typeof event.data.data === 'number') setAudioLevel(event.data.data);
      };
      streamRef.current = stream;
      audioContextRef.current = audioContext;
      workletRef.current = worklet;
      silentGainRef.current = silentGain;
      await audioContext.resume();
    } catch (captureError) {
      stream.getTracks().forEach((track) => track.stop());
      await audioContext.close();
      throw new Error(
        `Microphone capture could not start because the AudioWorklet failed to load. ${
          captureError instanceof Error ? captureError.message : ''
        }`.trim(),
      );
    }
  };

  const startSession = async () => {
    if (sessionOpen || startingRef.current) {
      startingRef.current = false;
      closeSession(true);
      return;
    }
    startingRef.current = true;
    setError(null);
    setNeedsMicPermission(false);
    setAgentState('connecting');
    try {
      await startCapture();
      if (!startingRef.current) return;
      const response = await sendToActiveTab({ type: 'SWARA_EXTRACT' });
      if (!startingRef.current) return;
      const page = extractPage(response);
      if (!page) throw new Error('The page returned an invalid scan result. Reload the tab, then try again.');

      const socket = new WebSocket(sessionUrl());
      socketRef.current = socket;
      socket.onopen = () => {
        startingRef.current = false;
        socket.send(JSON.stringify({ type: 'session.start', sessionId, page } satisfies ClientMessage));
        if (mountedRef.current) setSessionOpen(true);
      };
      socket.onmessage = (event: MessageEvent<string>) => {
        try {
          handleServerMessage(JSON.parse(event.data) as ServerMessage);
        } catch {
          setError('The session sent an unreadable response. Please start a new session.');
          setAgentState('error');
        }
      };
      socket.onerror = () => {
        startingRef.current = false;
        setError('Could not connect to the Swara session server.');
        setAgentState('error');
      };
      socket.onclose = () => {
        startingRef.current = false;
        if (!mountedRef.current) return;
        setSessionOpen(false);
        if (agentStateRef.current !== 'error') setAgentState('idle');
      };
    } catch (startError) {
      startingRef.current = false;
      stopCapture();
      const name = startError instanceof DOMException ? startError.name : '';
      const blocked = name === 'NotAllowedError' || name === 'SecurityError';
      setNeedsMicPermission(blocked);
      setError(
        blocked
          ? 'Chrome will not ask for microphone access from inside a side panel.'
          : startError instanceof Error
            ? startError.message
            : 'Unable to start Swara.',
      );
      setAgentState('error');
    }
  };

  const submitTypedTurn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = typedText.trim();
    if (!text || !sessionOpen) return;
    setConversation((items) => [...items, { id: `user-${Date.now()}`, kind: 'user', text }]);
    send({ type: 'text.turn', text });
    setTypedText('');
  };

  return (
    <main className="app">
      <header className="app-header">
        <h1>Swara</h1>
        <div className="header-actions">
          <button className="vault-link" type="button" onClick={() => void openVaultPage()}>Manage vault</button>
          <div className={`agent-state agent-state--${agentState}`} aria-live="polite">
            <span className="state-mark" aria-hidden="true"><i /><i /><i /></span>
            <span>{stateLabel(agentState)}</span>
          </div>
        </div>
      </header>

      <section className="conversation" aria-label="Conversation with Swara">
        {conversation.length === 0 && !partialTranscript && (
          <div className="conversation-empty">
            <p>Start a voice session and Swara will read this page, then ask where to begin.</p>
          </div>
        )}
        {conversation.map((item) => <ConversationItemView key={item.id} item={item} />)}
        {partialTranscript && <p className="turn turn--user turn--partial">{partialTranscript}<span className="live-caret" /></p>}
        <div ref={transcriptEndRef} />
      </section>

      {agentState === 'listening' && (
        <div className="listening-feedback" aria-label="Swara is listening">
          <span className="level-bars" style={{ '--level': Math.max(0.06, audioLevel).toString() } as React.CSSProperties}>
            <i /><i /><i /><i /><i />
          </span>
          <span>Listening</span>
        </div>
      )}

      <form className="text-turn" onSubmit={submitTypedTurn}>
        <label className="sr-only" htmlFor="typed-turn">Send a typed message</label>
        <input
          id="typed-turn"
          value={typedText}
          onChange={(event) => setTypedText(event.target.value)}
          disabled={!sessionOpen}
          placeholder={sessionOpen ? 'Type instead' : 'Start a voice session to type'}
        />
        <button type="submit" disabled={!sessionOpen || !typedText.trim()}>Send</button>
      </form>

      <div className="session-control">
        <button
          className={`mic-button${sessionOpen ? ' mic-button--active' : ''}`}
          type="button"
          onClick={() => void startSession()}
          aria-pressed={sessionOpen}
          aria-label={sessionOpen ? 'End voice session' : 'Start voice session'}
        >
          <span className="mic-shape" aria-hidden="true" />
          <span>{sessionOpen ? 'End session' : 'Start speaking'}</span>
        </button>
      </div>

      {(context.relevant.length > 0 || context.excluded.length > 0) && (
        <details className="reasoning-sidecar">
          <summary>Reasoning context</summary>
          <ContextList title="Relevant" items={context.relevant} />
          <ContextList title="Excluded" items={context.excluded} excluded />
        </details>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
          {needsMicPermission && (
            <button type="button" className="permission-button" onClick={() => void openPermissionPage()}>
              Grant microphone access
            </button>
          )}
        </p>
      )}
    </main>
  );
}

function stateLabel(state: AgentState): string {
  return {
    connecting: 'Connecting',
    idle: 'Ready',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Speaking',
    acting: 'Acting',
    error: 'Needs attention',
  }[state];
}

function ConversationItemView({ item }: { item: ConversationItem }) {
  if (item.kind === 'actions') {
    return (
      <article className={`turn-artifact action-artifact${item.results ? ' action-artifact--done' : ''}`}>
        <p>{actionSummary(item.actions, item.results)}</p>
        {item.results && <ActionResults results={item.results} />}
      </article>
    );
  }
  if (item.kind === 'memory') {
    return <article className="turn-artifact memory-artifact"><p>Remembered</p>{item.updates.map((update, index) => <div className="memory-update" key={`${update.key}-${index}`}><span className={`memory-badge memory-badge--${update.type}`}>{update.type}</span><span className="scope-badge">{update.scope}</span><strong>{update.key}</strong><span className="memory-value">{update.value}</span></div>)}</article>;
  }
  return <p className={`turn turn--${item.kind}`}>{item.text}</p>;
}

function ActionResults({ results }: { results: ActionResult[] }) {
  const failures = results.filter((result) => !result.ok);
  if (failures.length === 0) return null;
  return <small>{failures.map((result) => result.error || `${result.fieldId} could not be filled`).join(' · ')}</small>;
}

function ContextList({ title, items, excluded = false }: { title: string; items: ContextUsage[]; excluded?: boolean }) {
  if (!items.length) return null;
  return (
    <section className={excluded ? 'context-list context-list--excluded' : 'context-list'}>
      <h2>{title}</h2>
      {items.map((item) => <p key={`${item.key}-${item.reason}`}><strong>{item.key}</strong><span>{item.summary} · {item.reason}</span></p>)}
    </section>
  );
}

export default App;
