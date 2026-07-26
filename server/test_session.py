"""Local end-to-end test for the live-session WebSocket.

No network calls are made: Sarvam, Gemini, and the context vault are replaced
with deterministic fakes.
"""

from __future__ import annotations

import queue
import unittest
from contextlib import contextmanager
from typing import Any
from unittest.mock import patch

from fastapi.testclient import TestClient

import app
import session
from schemas import Action
from session_schemas import TurnResult


class FakeSTTSocket:
    def __init__(self) -> None:
        self.responses: queue.Queue[Any] = queue.Queue()
        self.transcriptions: list[tuple[str, str, int]] = []
        self.closed = False

    def __iter__(self):
        while True:
            response = self.responses.get()
            if response is None:
                return
            yield response

    def transcribe(
        self,
        audio: str,
        encoding: str = "audio/wav",
        sample_rate: int = 16_000,
    ) -> None:
        self.transcriptions.append((audio, encoding, sample_rate))
        self.responses.put(
            {"type": "events", "data": {"signal_type": "START_SPEECH"}}
        )
        self.responses.put(
            {"type": "events", "data": {"signal_type": "END_SPEECH"}}
        )
        self.responses.put(
            {
                "type": "data",
                "data": {
                    "transcript": "fill it",
                    "language_code": "en-IN",
                },
            }
        )

    def flush(self) -> None:
        return None

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            self.responses.put(None)


class FakeTTSSocket:
    def __init__(self, owner: "FakeSarvam") -> None:
        self.owner = owner
        self.text = ""
        self.closed = False

    def configure(self, **kwargs: Any) -> None:
        self.owner.tts_configurations.append(kwargs)

    def convert(self, text: str) -> None:
        self.text = text

    def flush(self) -> None:
        return None

    def __iter__(self):
        yield {
            "type": "audio",
            "data": {
                "audio": f"audio:{self.text}",
                "content_type": "audio/mp3",
            },
        }
        yield {"type": "event", "data": {"event_type": "final"}}

    def close(self) -> None:
        self.closed = True


class FakeSTTStreaming:
    def __init__(self, owner: "FakeSarvam") -> None:
        self.owner = owner

    @contextmanager
    def connect(self, **kwargs: Any):
        self.owner.stt_connect_kwargs.append(kwargs)
        try:
            yield self.owner.stt_socket
        finally:
            self.owner.stt_socket.close()


class FakeTTSStreaming:
    def __init__(self, owner: "FakeSarvam") -> None:
        self.owner = owner

    @contextmanager
    def connect(self, **kwargs: Any):
        self.owner.tts_connect_kwargs.append(kwargs)
        socket = FakeTTSSocket(self.owner)
        try:
            yield socket
        finally:
            socket.close()


class FakeSarvam:
    def __init__(self) -> None:
        self.stt_socket = FakeSTTSocket()
        self.stt_connect_kwargs: list[dict[str, Any]] = []
        self.tts_connect_kwargs: list[dict[str, Any]] = []
        self.tts_configurations: list[dict[str, Any]] = []
        self.speech_to_text_streaming = FakeSTTStreaming(self)
        self.text_to_speech_streaming = FakeTTSStreaming(self)


def receive_through(websocket: Any, final_type: str) -> list[dict[str, Any]]:
    messages = []
    while True:
        message = websocket.receive_json()
        messages.append(message)
        if message["type"] == final_type:
            return messages


def assert_subsequence(test: unittest.TestCase, actual: list[str], expected: list[str]) -> None:
    position = 0
    for item in actual:
        if position < len(expected) and item == expected[position]:
            position += 1
    test.assertEqual(
        position,
        len(expected),
        f"Expected subsequence {expected!r}, got {actual!r}",
    )


class LiveSessionTest(unittest.TestCase):
    def test_fake_streaming_session_and_turn_recovery(self) -> None:
        fake_sarvam = FakeSarvam()
        turn_calls: list[dict[str, Any]] = []

        def fake_run_turn(**kwargs: Any) -> TurnResult:
            turn_calls.append(kwargs)
            if kwargs["opening"]:
                return TurnResult(speech="I can help with this application.")
            utterance = kwargs["utterance"]
            if utterance == "fill it":
                return TurnResult(
                    speech="I filled the name.",
                    actions=[
                        Action(
                            field_id="full-name",
                            action="fill",
                            value="Ada Lovelace",
                        )
                    ],
                )
            if utterance == "explode":
                raise RuntimeError("simulated turn failure")
            if utterance == "recover":
                return TurnResult(speech="Still here.")
            raise AssertionError(f"Unexpected utterance: {utterance}")

        page = {
            "url": "https://example.test/apply",
            "title": "Example application",
            "heading": "Apply",
            "fields": [
                {
                    "fieldId": "full-name",
                    "label": "Full name",
                    "question": "What is your full name?",
                    "type": "text",
                    "required": True,
                }
            ],
        }

        with (
            patch.object(session, "_sarvam_client", return_value=fake_sarvam),
            patch.object(session, "_context_for_session", return_value=[]),
            patch.object(session, "run_turn", side_effect=fake_run_turn),
            TestClient(app.app) as client,
            client.websocket_connect("/session/live") as websocket,
        ):
            websocket.send_json(
                {
                    "type": "session.start",
                    "sessionId": "test-session",
                    "page": page,
                }
            )
            opening = receive_through(websocket, "agent.audio.end")
            opening.extend(receive_through(websocket, "state"))
            opening_types = [message["type"] for message in opening]
            assert_subsequence(
                self,
                opening_types,
                [
                    "state",
                    "agent.text",
                    "context.used",
                    "state",
                    "agent.audio",
                    "agent.audio.end",
                    "state",
                ],
            )
            self.assertEqual(opening[-1], {"type": "state", "state": "listening"})

            websocket.send_json({"type": "audio.chunk", "data": "cGNt"})
            streamed = receive_through(websocket, "agent.audio.end")
            streamed.extend(receive_through(websocket, "agent.actions"))
            streamed.extend(receive_through(websocket, "state"))
            streamed_types = [message["type"] for message in streamed]
            assert_subsequence(
                self,
                streamed_types,
                [
                    "speech.start",
                    "speech.end",
                    "transcript.final",
                    "state",
                    "agent.text",
                    "context.used",
                    "state",
                    "agent.audio",
                    "agent.audio.end",
                    "state",
                    "agent.actions",
                    "state",
                ],
            )
            action_message = next(
                message
                for message in streamed
                if message["type"] == "agent.actions"
            )
            self.assertEqual(
                action_message["actions"][0],
                {
                    "fieldId": "full-name",
                    "action": "fill",
                    "value": "Ada Lovelace",
                },
            )

            websocket.send_json(
                {
                    "type": "action.result",
                    "results": [{"fieldId": "full-name", "ok": True}],
                }
            )
            websocket.send_json({"type": "text.turn", "text": "explode"})
            failed = receive_through(websocket, "error")
            failed.extend(receive_through(websocket, "state"))
            error = next(message for message in failed if message["type"] == "error")
            self.assertEqual(error["fatal"], False)
            self.assertIn("simulated turn failure", error["message"])
            self.assertEqual(failed[-1], {"type": "state", "state": "listening"})

            # A second turn on the same socket proves the prior exception did
            # not end the session.
            websocket.send_json({"type": "text.turn", "text": "recover"})
            recovered = receive_through(websocket, "agent.audio.end")
            recovered.extend(receive_through(websocket, "state"))
            self.assertTrue(
                any(
                    message == {"type": "agent.text", "text": "Still here."}
                    for message in recovered
                )
            )
            websocket.send_json({"type": "session.stop"})

        self.assertEqual(
            fake_sarvam.stt_connect_kwargs,
            [
                {
                    "language_code": "unknown",
                    "model": "saaras:v3",
                    "mode": "transcribe",
                    "input_audio_codec": "pcm_s16le",
                    "sample_rate": "16000",
                    **session.VAD_SETTINGS,
                }
            ],
        )
        self.assertEqual(
            fake_sarvam.stt_socket.transcriptions,
            [("cGNt", "pcm_s16le", 16_000)],
        )
        self.assertTrue(
            all(
                kwargs
                == {"model": "bulbul:v3", "send_completion_event": "true"}
                for kwargs in fake_sarvam.tts_connect_kwargs
            )
        )
        self.assertTrue(
            all(
                kwargs["target_language_code"] == "en-IN"
                and kwargs["speaker"] == "advait"
                for kwargs in fake_sarvam.tts_configurations
            )
        )
        recovery_history = next(
            call["history"]
            for call in turn_calls
            if call["utterance"] == "recover"
        )
        self.assertTrue(
            any("full-name: succeeded" in turn.text for turn in recovery_history)
        )

        print(
            "ORDER:",
            " -> ".join(streamed_types),
        )
        print(
            "RECOVERY:",
            "non-fatal turn error followed by successful turn on same WebSocket",
        )
        print(
            "SARVAM:",
            fake_sarvam.stt_connect_kwargs[0],
            fake_sarvam.tts_connect_kwargs[0],
            fake_sarvam.tts_configurations[0],
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
