import json
import os
import sys
import tempfile


def main() -> int:
    audio = sys.stdin.buffer.read()
    if not audio:
        print(json.dumps({"text": "", "error": "empty_audio"}), flush=True)
        return 0

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        print(
            json.dumps(
                {
                    "text": "",
                    "error": "missing_dependency",
                    "message": f"Install faster-whisper: {exc}",
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 0

    model_name = os.environ.get("LOCAL_WHISPER_MODEL", "tiny")
    device = os.environ.get("LOCAL_WHISPER_DEVICE", "cpu")
    compute_type = os.environ.get("LOCAL_WHISPER_COMPUTE_TYPE", "int8")
    language = os.environ.get("TALK_CODING_STT_LANGUAGE_CODE", "ja")
    beam_size = int(os.environ.get("LOCAL_WHISPER_BEAM_SIZE", "1"))

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(audio)
            tmp_path = tmp.name

        model = WhisperModel(model_name, device=device, compute_type=compute_type)
        segments, info = model.transcribe(
            tmp_path,
            language=language or None,
            beam_size=beam_size,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        text = "".join(segment.text for segment in segments).strip()
        print(
            json.dumps(
                {
                    "text": text,
                    "language": getattr(info, "language", language),
                    "language_probability": getattr(info, "language_probability", None),
                    "model": model_name,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 0
    except Exception as exc:
        print(
            json.dumps(
                {
                    "text": "",
                    "error": "transcription_failed",
                    "message": str(exc),
                    "model": model_name,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 0
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
