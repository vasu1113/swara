"""Persistent live voice sessions.

FastAPI owns the browser-facing async WebSocket. Sarvam's installed SDK exposes
sync streaming sockets, so small worker threads own those sockets and bridge
messages through thread-safe queues without blocking the application event
loop.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import queue
import threading
from contextlib import suppress
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from config import require
from context_store import apply_memory_update, list_context
from conversation_prompts import (
    SESSION_PERSONA,
    build_opening_prompt,
    build_turn_prompt,
)
from schemas import ActionResult, ContextItem, PageContext
from session_schemas import (
    AUDIO_SAMPLE_RATE,
    VAD_SETTINGS,
    SessionStart,
    Turn,
    TurnResult,
)


logger = logging.getLogger("swara.session")

router = APIRouter()

# Conversation is latency-bound in a way batch planning is not: one second of
# thinking reads as responsive, three reads as broken. flash-lite answers in
# ~1s against ~3.4s for the larger flash models, which matters more here than
# the extra reasoning headroom. Override with SWARA_SESSION_MODEL.
SESSION_MODEL = os.environ.get("SWARA_SESSION_MODEL", "gemini-3.1-flash-lite")

STT_MODEL = "saaras:v3"
TTS_MODEL = "bulbul:v3"
TTS_SPEAKER = "advait"
TTS_DEFAULT_LANGUAGE = "en-IN"
TTS_MIME_TYPE = "audio/mpeg"  # canonical; MediaSource rejects "audio/mp3"


def _sarvam_client() -> Any:
    try:
        from sarvamai import SarvamAI
    except ImportError as exc:
        raise RuntimeError(
            "Sarvam SDK is unavailable. Install server/requirements.txt."
        ) from exc
    return SarvamAI(api_subscription_key=require("SARVAM_API_KEY"))


def _context_for_session(session_id: str) -> list[ContextItem]:
    """Load context with the same scope and de-duplication rules as planner."""
    items = [
        *list_context(scope="persistent"),
        *list_context(scope="session", session_id=session_id),
        *list_context(scope="task", session_id=session_id),
    ]
    seen: set[str] = set()
    unique: list[ContextItem] = []
    for item in items:
        marker = item.id or f"{item.scope}:{item.session_id}:{item.key}:{item.value}"
        if marker not in seen:
            seen.add(marker)
            unique.append(item)
    return unique


def run_turn(
    *,
    session_id: str,
    page: PageContext,
    context_items: list[ContextItem],
    history: list[Turn],
    utterance: str | None = None,
    opening: bool = False,
) -> TurnResult:
    """Run one schema-constrained Gemini turn and persist learned memory."""
    try:
        from google import genai
        from google.genai import types
    except ImportError as exc:
        raise RuntimeError(
            "Google Gen AI SDK is unavailable. Install server/requirements.txt."
        ) from exc

    if opening:
        prompt = build_opening_prompt(page, context_items)
    else:
        if utterance is None:
            raise ValueError("A conversational turn requires an utterance.")
        prompt = build_turn_prompt(page, context_items, history, utterance)

    client = genai.Client(api_key=require("GOOGLE_API_KEY"))
    try:
        response = client.models.generate_content(
            model=SESSION_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=SESSION_PERSONA,
                response_mime_type="application/json",
                response_schema=TurnResult,
                # One attempt. The default backoff silently turns an exhausted
                # quota into seconds of dead air per turn, which is felt as the
                # agent being slow rather than as the hard failure it is.
                http_options=types.HttpOptions(
                    retry_options=types.HttpRetryOptions(attempts=1)
                ),
            ),
        )
    except Exception as exc:
        if "RESOURCE_EXHAUSTED" in str(exc) or "429" in str(exc):
            raise RuntimeError(
                f"The {SESSION_MODEL} quota is exhausted. Enable billing on the "
                "Google API key, or set SWARA_SESSION_MODEL to a model with "
                "remaining quota."
            ) from exc
        raise
    result = TurnResult.model_validate_json(response.text or "")
    for update in result.memory_updates:
        apply_memory_update(update, session_id=session_id)
    return result



SPEECH_ONLY_SUFFIX = """

## This channel is speech only

Return only the words to say aloud. No JSON, no field names, no lists of
actions. A separate pass handles what changes on the page, so describe what you
are doing in natural speech and nothing more."""

# Sentence ends, including the Devanagari danda so Hindi splits correctly.
_SENTENCE_END = re.compile(r"(?<=[.!?।])\s+")


class _LLMStreamBridge:
    """Stream Gemini's spoken reply sentence by sentence.

    Waiting for a complete response before speaking costs a second or more of
    dead air on every turn, which is most of what makes a voice agent feel
    slow. Sentences are emitted as they finish so synthesis can start on the
    first one while the rest is still being written.
    """

    def __init__(self, loop, prompt: str) -> None:
        self._loop = loop
        self._prompt = prompt
        self.events: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
        self._stopped = threading.Event()
        self._thread = threading.Thread(
            target=self._run, name="swara-llm-stream", daemon=True
        )

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stopped.set()

    def _publish(self, kind: str, payload: Any = None) -> None:
        with suppress(RuntimeError):
            self._loop.call_soon_threadsafe(self.events.put_nowait, (kind, payload))

    def _run(self) -> None:
        try:
            from google import genai
            from google.genai import types

            client = genai.Client(api_key=require("GOOGLE_API_KEY"))
            stream = client.models.generate_content_stream(
                model=SESSION_MODEL,
                contents=self._prompt + SPEECH_ONLY_SUFFIX,
                config=types.GenerateContentConfig(
                    system_instruction=SESSION_PERSONA,
                    http_options=types.HttpOptions(
                        retry_options=types.HttpRetryOptions(attempts=1)
                    ),
                ),
            )
            buffer = ""
            for chunk in stream:
                if self._stopped.is_set():
                    break
                buffer += getattr(chunk, "text", "") or ""
                parts = _SENTENCE_END.split(buffer)
                # The trailing fragment may still be mid-sentence, so hold it.
                for sentence in parts[:-1]:
                    if sentence.strip():
                        self._publish("sentence", sentence.strip())
                buffer = parts[-1]
            if buffer.strip() and not self._stopped.is_set():
                self._publish("sentence", buffer.strip())
        except Exception as exc:
            if "RESOURCE_EXHAUSTED" in str(exc) or "429" in str(exc):
                self._publish(
                    "error",
                    f"The {SESSION_MODEL} quota is exhausted. Enable billing on "
                    "the Google API key.",
                )
            else:
                self._publish("error", str(exc))
        finally:
            self._publish("done")


def _field(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def _close_sdk_socket(socket: Any) -> None:
    """Close an SDK socket even though v0.1.28 exposes no public close method."""
    close = getattr(socket, "close", None)
    if callable(close):
        with suppress(Exception):
            close()
        return
    raw_socket = getattr(socket, "_websocket", None)
    close = getattr(raw_socket, "close", None)
    if callable(close):
        with suppress(Exception):
            close()


class _STTBridge:
    """Own Sarvam STT's sync context manager and relay its events to asyncio."""

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        events: asyncio.Queue[tuple[str, Any]],
    ) -> None:
        self._loop = loop
        self._events = events
        self._commands: queue.Queue[tuple[str, Any]] = queue.Queue(maxsize=256)
        self._stopped = threading.Event()
        self._thread = threading.Thread(
            target=self._run,
            name="swara-sarvam-stt",
            daemon=True,
        )
        self._socket: Any = None

    def start(self) -> None:
        self._thread.start()

    def send_audio(self, audio_base64: str) -> bool:
        if self._stopped.is_set():
            return False
        try:
            self._commands.put_nowait(("audio", audio_base64))
        except queue.Full:
            return False
        return True

    def stop(self) -> None:
        if self._stopped.is_set():
            return
        try:
            self._commands.put_nowait(("stop", None))
        except queue.Full:
            # Preserve prompt shutdown over old audio if the sender fell behind.
            with suppress(queue.Empty):
                self._commands.get_nowait()
            with suppress(queue.Full):
                self._commands.put_nowait(("stop", None))

    def join(self, timeout: float = 2.0) -> None:
        if self._thread.is_alive():
            self._thread.join(timeout)

    def _publish(self, kind: str, payload: Any = None) -> None:
        with suppress(RuntimeError):
            self._loop.call_soon_threadsafe(
                self._events.put_nowait, (kind, payload)
            )

    def _read(self, socket: Any) -> None:
        try:
            for response in socket:
                self._publish("stt.message", response)
        except Exception as exc:
            if not self._stopped.is_set():
                self._publish("stt.error", str(exc))
        finally:
            with suppress(queue.Full):
                self._commands.put_nowait(("reader.done", None))

    def _run(self) -> None:
        try:
            client = _sarvam_client()
            with client.speech_to_text_streaming.connect(
                language_code="unknown",
                model=STT_MODEL,
                mode="transcribe",
                input_audio_codec="pcm_s16le",
                sample_rate=str(AUDIO_SAMPLE_RATE),
                **VAD_SETTINGS,
            ) as socket:
                self._socket = socket
                reader = threading.Thread(
                    target=self._read,
                    args=(socket,),
                    name="swara-sarvam-stt-reader",
                    daemon=True,
                )
                reader.start()

                while True:
                    command, payload = self._commands.get()
                    if command in {"stop", "reader.done"}:
                        if command == "stop":
                            with suppress(Exception):
                                socket.flush()
                        break
                    if command == "audio":
                        # `encoding` here is a fixed literal and rejects
                        # anything else; the real codec is declared once at
                        # connect() via input_audio_codec. Passing the codec
                        # per chunk raises on the first frame and kills this
                        # thread, after which every send reports "busy".
                        socket.transcribe(
                            payload,
                            encoding="audio/wav",
                            sample_rate=AUDIO_SAMPLE_RATE,
                        )
        except Exception as exc:
            if not self._stopped.is_set():
                self._publish("stt.error", str(exc))
        finally:
            self._stopped.set()
            if self._socket is not None:
                _close_sdk_socket(self._socket)
            self._publish("stt.closed")


class _TTSBridge:
    """Stream one utterance through Sarvam TTS without blocking asyncio."""

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        text: str,
        language: str,
    ) -> None:
        self.events: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
        self._loop = loop
        self._text = text
        self._language = language
        self._interrupted = threading.Event()
        self._socket: Any = None
        self._thread = threading.Thread(
            target=self._run,
            name="swara-sarvam-tts",
            daemon=True,
        )

    @property
    def interrupted(self) -> bool:
        return self._interrupted.is_set()

    def start(self) -> None:
        self._thread.start()

    def interrupt(self) -> None:
        """Suppress queued audio now and close the blocking socket in parallel."""
        self._interrupted.set()
        socket = self._socket
        if socket is not None:
            threading.Thread(
                target=_close_sdk_socket,
                args=(socket,),
                name="swara-sarvam-tts-close",
                daemon=True,
            ).start()

    def _publish(self, kind: str, payload: Any = None) -> None:
        if kind == "audio" and self._interrupted.is_set():
            return
        with suppress(RuntimeError):
            self._loop.call_soon_threadsafe(
                self.events.put_nowait, (kind, payload)
            )

    def _run(self) -> None:
        try:
            client = _sarvam_client()
            with client.text_to_speech_streaming.connect(
                model=TTS_MODEL,
                send_completion_event="true",
            ) as socket:
                self._socket = socket
                if self._interrupted.is_set():
                    return
                socket.configure(
                    target_language_code=self._language,
                    speaker=TTS_SPEAKER,
                )
                socket.convert(self._text)
                socket.flush()

                for response in socket:
                    if self._interrupted.is_set():
                        break
                    response_type = str(_field(response, "type", ""))
                    data = _field(response, "data")
                    if response_type == "audio":
                        audio = _field(data, "audio")
                        mime_type = _field(data, "content_type", TTS_MIME_TYPE)
                        if isinstance(audio, str) and audio:
                            self._publish(
                                "audio",
                                {
                                    "data": audio,
                                    "mimeType": (
                                        mime_type
                                        if isinstance(mime_type, str)
                                        else TTS_MIME_TYPE
                                    ),
                                },
                            )
                    elif response_type == "event":
                        if _field(data, "event_type") == "final":
                            break
                    elif response_type == "error":
                        message = _field(data, "message", "Speech synthesis failed.")
                        raise RuntimeError(str(message))
        except Exception as exc:
            if not self._interrupted.is_set():
                self._publish("error", str(exc))
        finally:
            self._publish("done")


def _target_language(language: str | None, text: str) -> str:
    if language and language != "unknown":
        return language
    if any("\u0900" <= character <= "\u097f" for character in text):
        return "hi-IN"
    return TTS_DEFAULT_LANGUAGE


def _action_result_text(results: list[ActionResult]) -> str:
    details = []
    for result in results:
        if result.ok:
            details.append(f"{result.field_id}: succeeded")
        else:
            reason = f" ({result.error})" if result.error else ""
            details.append(f"{result.field_id}: failed{reason}")
    return "Action results from the page: " + "; ".join(details)


class _LiveSession:
    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        self.events: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
        self.send_lock = asyncio.Lock()
        self.session_id = ""
        self.page: PageContext | None = None
        self.context_items: list[ContextItem] = []
        self.history: list[Turn] = []
        self.last_language: str | None = None
        self.receiver_task: asyncio.Task[None] | None = None
        self.response_task: asyncio.Task[None] | None = None
        self.active_tts: _TTSBridge | None = None
        self.stt: _STTBridge | None = None
        self.generation = 0
        self.started = False
        self.peer_disconnected = False

    async def send(self, message: dict[str, Any]) -> None:
        async with self.send_lock:
            await self.websocket.send_json(message)

    async def _receive(self) -> None:
        try:
            while True:
                message = await self.websocket.receive_json()
                await self.events.put(("client.message", message))
        except WebSocketDisconnect:
            await self.events.put(("client.disconnected", None))
        except Exception as exc:
            await self.events.put(("client.error", str(exc)))

    async def _start(self, message: dict[str, Any]) -> None:
        start = SessionStart.model_validate(message)
        self.session_id = start.session_id
        self.page = start.page
        self.context_items = await asyncio.to_thread(
            _context_for_session, self.session_id
        )
        self.started = True

        loop = asyncio.get_running_loop()
        self.stt = _STTBridge(loop, self.events)
        self.stt.start()
        await self._begin_response(opening=True)

    async def _cancel_response(self) -> None:
        task = self.response_task
        if task is None or task.done():
            return
        if self.active_tts is not None:
            self.active_tts.interrupt()
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        self.response_task = None

    async def _begin_response(
        self,
        *,
        utterance: str | None = None,
        opening: bool = False,
    ) -> None:
        await self._cancel_response()
        self.generation += 1
        generation = self.generation
        history_for_prompt = list(self.history)
        if utterance is not None:
            self.history.append(Turn(role="user", text=utterance))
        self.response_task = asyncio.create_task(
            self._respond(
                generation=generation,
                history_for_prompt=history_for_prompt,
                utterance=utterance,
                opening=opening,
            )
        )

    async def _respond(
        self,
        *,
        generation: int,
        history_for_prompt: list[Turn],
        utterance: str | None,
        opening: bool,
    ) -> None:
        try:
            if self.page is None:
                raise RuntimeError("The live session has no page context.")
            page = self.page
            context_items = list(self.context_items)
            await self.send({"type": "state", "state": "thinking"})

            # Two calls run at once. The streaming one starts speaking on its
            # first finished sentence, so audio begins in well under a second
            # instead of after the whole reply exists. The structured one
            # decides what changes on the page and lands whenever it is ready,
            # typically while the agent is still talking.
            structured = asyncio.create_task(
                asyncio.to_thread(
                    run_turn,
                    session_id=self.session_id,
                    page=page,
                    context_items=context_items,
                    history=history_for_prompt,
                    utterance=utterance,
                    opening=opening,
                )
            )
            spoken = await self._stream_speech(
                generation=generation,
                page=page,
                context_items=context_items,
                history_for_prompt=history_for_prompt,
                utterance=utterance,
                opening=opening,
            )

            try:
                result = await structured
            except Exception:
                structured.cancel()
                raise
            if generation != self.generation:
                return
            # The spoken words are what the user actually heard, so they are
            # what goes into history and onto the transcript.
            if spoken:
                result.speech = spoken

            self.history.append(
                Turn(role="agent", text=result.speech, actions=result.actions)
            )
            # The streaming pass already emitted each sentence; resending the
            # whole reply here would show it twice.
            if not spoken:
                await self.send({"type": "agent.text", "text": result.speech})
            await self.send(
                {
                    "type": "context.used",
                    "relevant": [
                        item.model_dump(by_alias=True, exclude_none=True)
                        for item in result.relevant_context
                    ],
                    "excluded": [
                        item.model_dump(by_alias=True, exclude_none=True)
                        for item in result.excluded_context
                    ],
                }
            )
            if result.memory_updates:
                await self.send(
                    {
                        "type": "memory.learned",
                        "updates": [
                            update.model_dump(by_alias=True, exclude_none=True)
                            for update in result.memory_updates
                        ],
                    }
                )
                try:
                    self.context_items = await asyncio.to_thread(
                        _context_for_session, self.session_id
                    )
                except Exception as exc:
                    await self.send(
                        {
                            "type": "error",
                            "message": f"Memory was saved but context refresh failed: {exc}",
                            "fatal": False,
                        }
                    )
            if result.question:
                await self.send(
                    {"type": "agent.question", "text": result.question}
                )

            # Act before speaking, not after. Speech takes seconds; holding the
            # page until it finishes means hearing "I've filled that in" while
            # staring at an unchanged form. Filling first also means a barge-in
            # cannot strand actions the agent already announced.
            if result.actions:
                await self.send({"type": "state", "state": "acting"})
                await self.send(
                    {
                        "type": "agent.actions",
                        "actions": [
                            action.model_dump(by_alias=True, exclude_none=True)
                            for action in result.actions
                        ],
                    }
                )

            await self.send(
                {
                    "type": "state",
                    "state": "idle" if result.done else "listening",
                }
            )
        except asyncio.CancelledError:
            if self.active_tts is not None:
                self.active_tts.interrupt()
            raise
        except Exception as exc:
            if generation == self.generation:
                await self.send(
                    {"type": "error", "message": str(exc), "fatal": False}
                )
                await self.send({"type": "state", "state": "listening"})

    async def _stream_speech(
        self,
        *,
        generation: int,
        page: PageContext,
        context_items: list[ContextItem],
        history_for_prompt: list[Turn],
        utterance: str | None,
        opening: bool,
    ) -> str:
        """Speak Gemini's reply as it is written, returning what was said."""
        prompt = (
            build_opening_prompt(page, context_items)
            if opening
            else build_turn_prompt(page, context_items, history_for_prompt, utterance or "")
        )
        bridge = _LLMStreamBridge(asyncio.get_running_loop(), prompt)
        bridge.start()

        said: list[str] = []
        spoke_any = False
        try:
            while True:
                kind, payload = await bridge.events.get()
                if kind == "done":
                    break
                if kind == "error":
                    await self.send(
                        {"type": "error", "message": str(payload), "fatal": False}
                    )
                    break
                if kind != "sentence" or generation != self.generation:
                    continue

                sentence = str(payload)
                said.append(sentence)
                # Emit the words before the audio so the transcript leads the
                # voice rather than lagging behind it.
                await self.send({"type": "agent.text", "text": sentence})
                if not spoke_any:
                    await self.send({"type": "state", "state": "speaking"})
                    spoke_any = True
                await self._speak_sentence(
                    generation, sentence, _target_language(self.last_language, sentence)
                )
                if generation != self.generation:
                    break
        finally:
            bridge.stop()
            if generation == self.generation and spoke_any:
                await self.send({"type": "agent.audio.end"})

        return " ".join(said)

    async def _speak_sentence(
        self, generation: int, text: str, language: str
    ) -> None:
        """Synthesise one sentence, streaming its audio out as it arrives."""
        if not text.strip():
            return
        bridge = _TTSBridge(asyncio.get_running_loop(), text, language)
        self.active_tts = bridge
        bridge.start()
        try:
            while True:
                kind, payload = await bridge.events.get()
                if kind == "done":
                    break
                if kind == "error":
                    await self.send(
                        {
                            "type": "error",
                            "message": f"Speech synthesis failed: {payload}",
                            "fatal": False,
                        }
                    )
                    break
                if (
                    kind == "audio"
                    and generation == self.generation
                    and not bridge.interrupted
                ):
                    await self.send(
                        {
                            "type": "agent.audio",
                            "data": payload["data"],
                            "mimeType": payload["mimeType"],
                        }
                    )
        finally:
            bridge.interrupt()
            if self.active_tts is bridge:
                self.active_tts = None

    async def _speak(
        self,
        generation: int,
        text: str,
        language: str,
    ) -> None:
        await self.send({"type": "state", "state": "speaking"})
        if not text.strip():
            await self.send({"type": "agent.audio.end"})
            return

        bridge = _TTSBridge(asyncio.get_running_loop(), text, language)
        self.active_tts = bridge
        bridge.start()
        try:
            while True:
                kind, payload = await bridge.events.get()
                if kind == "done":
                    break
                if kind == "error":
                    await self.send(
                        {
                            "type": "error",
                            "message": f"Speech synthesis failed: {payload}",
                            "fatal": False,
                        }
                    )
                    break
                if (
                    kind == "audio"
                    and generation == self.generation
                    and not bridge.interrupted
                ):
                    await self.send(
                        {
                            "type": "agent.audio",
                            "data": payload["data"],
                            "mimeType": payload["mimeType"],
                        }
                    )
        finally:
            bridge.interrupt()
            if self.active_tts is bridge:
                self.active_tts = None
            if generation == self.generation:
                await self.send({"type": "agent.audio.end"})

    async def _interrupt_tts(self) -> None:
        if self.active_tts is not None:
            self.active_tts.interrupt()

    async def _handle_stt(self, response: Any) -> None:
        response_type = str(_field(response, "type", ""))
        data = _field(response, "data")
        if response_type == "events":
            signal = str(_field(data, "signal_type", ""))
            if signal == "START_SPEECH":
                # Set the interrupt flag before sending the boundary so no
                # in-flight audio chunk can slip past the barge-in event.
                await self._interrupt_tts()
                await self.send({"type": "speech.start"})
            elif signal == "END_SPEECH":
                await self.send({"type": "speech.end"})
            return

        if response_type == "error":
            message = _field(data, "error", "Speech transcription failed.")
            await self.send(
                {"type": "error", "message": str(message), "fatal": False}
            )
            return
        if response_type != "data":
            return

        transcript = _field(data, "transcript")
        if not isinstance(transcript, str) or not transcript.strip():
            return
        transcript = transcript.strip()
        language = _field(data, "language_code")
        if isinstance(language, str) and language:
            self.last_language = language

        # Saaras v3's schema emits completed segments as `data`. Honour an
        # explicit false `is_final` from compatible SDK responses as interim.
        is_final = _field(data, "is_final", _field(response, "is_final", True))
        if is_final is False:
            await self.send({"type": "transcript.partial", "text": transcript})
            return

        final: dict[str, Any] = {"type": "transcript.final", "text": transcript}
        if isinstance(language, str) and language:
            final["language"] = language
        await self.send(final)
        await self._begin_response(utterance=transcript)

    async def _handle_client(self, message: Any) -> bool:
        if not isinstance(message, dict) or not isinstance(message.get("type"), str):
            await self.send(
                {
                    "type": "error",
                    "message": "Client messages must be JSON objects with a type.",
                    "fatal": not self.started,
                }
            )
            return self.started

        message_type = message["type"]
        if not self.started:
            if message_type != "session.start":
                await self.send(
                    {
                        "type": "error",
                        "message": "The first message must be session.start.",
                        "fatal": True,
                    }
                )
                return False
            try:
                await self._start(message)
            except Exception as exc:
                await self.send(
                    {"type": "error", "message": str(exc), "fatal": True}
                )
                return False
            return True

        try:
            if message_type == "audio.chunk":
                data = message.get("data")
                if not isinstance(data, str) or not data:
                    raise ValueError("audio.chunk requires non-empty base64 data.")
                if self.stt is None or not self.stt.send_audio(data):
                    raise RuntimeError("Speech transcription is unavailable or busy.")
            elif message_type == "text.turn":
                text = message.get("text")
                if not isinstance(text, str) or not text.strip():
                    raise ValueError("text.turn requires non-empty text.")
                await self._begin_response(utterance=text.strip())
            elif message_type == "action.result":
                raw_results = message.get("results")
                if not isinstance(raw_results, list):
                    raise ValueError("action.result requires a results array.")
                results = [ActionResult.model_validate(item) for item in raw_results]
                for turn in reversed(self.history):
                    if turn.role == "agent" and turn.actions:
                        turn.results.extend(results)
                        break
                if results:
                    self.history.append(
                        Turn(
                            role="user",
                            text=_action_result_text(results),
                            results=results,
                        )
                    )
            elif message_type == "page.update":
                self.page = PageContext.model_validate(message.get("page"))
            elif message_type == "agent.interrupt":
                await self._interrupt_tts()
            elif message_type == "session.stop":
                return False
            elif message_type == "session.start":
                raise ValueError("The live session has already started.")
            else:
                raise ValueError(f"Unknown client message type: {message_type}")
        except Exception as exc:
            await self.send(
                {"type": "error", "message": str(exc), "fatal": False}
            )
        return True

    async def run(self) -> None:
        await self.websocket.accept()
        self.receiver_task = asyncio.create_task(self._receive())
        keep_running = True
        try:
            while keep_running:
                kind, payload = await self.events.get()
                if kind == "client.message":
                    keep_running = await self._handle_client(payload)
                elif kind == "client.disconnected":
                    self.peer_disconnected = True
                    break
                elif kind == "client.error":
                    await self.send(
                        {"type": "error", "message": str(payload), "fatal": True}
                    )
                    break
                elif kind == "stt.message":
                    await self._handle_stt(payload)
                elif kind == "stt.error":
                    # Also log it: the client only ever showed a generic
                    # "unavailable or busy", which hid the real cause.
                    logger.error("Sarvam STT error: %s", payload)
                    await self.send(
                        {
                            "type": "error",
                            "message": f"Speech transcription failed: {payload}",
                            "fatal": False,
                        }
                    )
                elif kind == "stt.closed" and self.started:
                    # Typed turns remain available even if the STT provider
                    # disconnects, so this is deliberately non-fatal.
                    pass
        finally:
            self.generation += 1
            await self._cancel_response()
            if self.active_tts is not None:
                self.active_tts.interrupt()
            if self.stt is not None:
                self.stt.stop()
                await asyncio.to_thread(self.stt.join)
            if self.receiver_task is not None:
                self.receiver_task.cancel()
                with suppress(asyncio.CancelledError):
                    await self.receiver_task
            if not self.peer_disconnected:
                with suppress(Exception):
                    await self.websocket.close(code=1000)


@router.websocket("/session/live")
async def live_session(websocket: WebSocket) -> None:
    await _LiveSession(websocket).run()
