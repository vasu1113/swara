"""Live voice-session protocol.

Mirrors `extension/src/types/session.ts` — change both together.

One WebSocket carries JSON control messages both ways plus base64 audio, so a
chunk can never overtake the state change that explains it.

Audio in is base64 Int16 PCM at 16 kHz. Sarvam's streaming STT accepts
wav / pcm_s16le / pcm_l16 / pcm_raw only — webm/opus is rejected, so the client
captures raw PCM via AudioWorklet rather than MediaRecorder.
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from schemas import (
    Action,
    ActionResult,
    Base,
    ContextUsage,
    MemoryUpdate,
    PageContext,
)

AgentState = Literal[
    "connecting", "idle", "listening", "thinking", "speaking", "acting", "error"
]

AUDIO_SAMPLE_RATE = 16_000

# Sarvam streaming STT tuning. Deliberately a shade patient: cutting a speaker
# off mid-thought reads as broken, while a beat of silence reads as listening.
VAD_SETTINGS = {
    "vad_signals": "true",
    "high_vad_sensitivity": "true",
    # Frames of speech before a turn is considered started — filters coughs
    # and room noise without clipping a real opening word.
    "min_speech_frames": "6",
    # Audio retained from before the trigger, so the first phoneme survives.
    "pre_speech_pad_frames": "8",
    # Speech needed to interrupt the agent mid-sentence (barge-in).
    "interrupt_min_speech_frames": "4",
}


class SessionStart(Base):
    session_id: str
    page: PageContext


class TurnResult(Base):
    """One turn's output: what to say, what to do, what was learned."""

    speech: str = ""
    actions: list[Action] = Field(default_factory=list)
    question: str | None = None
    memory_updates: list[MemoryUpdate] = Field(default_factory=list)
    relevant_context: list[ContextUsage] = Field(default_factory=list)
    excluded_context: list[ContextUsage] = Field(default_factory=list)
    # Set when the agent believes the task is finished, so the UI can settle.
    done: bool = False


class Turn(Base):
    """A single exchange, kept in session history."""

    role: Literal["user", "agent"]
    text: str
    actions: list[Action] = Field(default_factory=list)
    results: list[ActionResult] = Field(default_factory=list)
