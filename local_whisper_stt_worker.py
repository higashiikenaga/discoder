import json
import os
import struct
import sys
import tempfile


def write_json(data):
    print(json.dumps(data, ensure_ascii=False), flush=True)


def read_exact(size):
    chunks = []
    remaining = size
    while remaining > 0:
        chunk = sys.stdin.buffer.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def main() -> int:
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        write_json(
            {
                "text": "",
                "error": "missing_dependency",
                "message": f"Install faster-whisper: {exc}",
            }
        )
        return 1

    model_name = os.environ.get("LOCAL_WHISPER_MODEL", "tiny")
    device = os.environ.get("LOCAL_WHISPER_DEVICE", "cpu")
    compute_type = os.environ.get("LOCAL_WHISPER_COMPUTE_TYPE", "int8")
    language = os.environ.get("TALK_CODING_STT_LANGUAGE_CODE", "ja")
    beam_size = int(os.environ.get("LOCAL_WHISPER_BEAM_SIZE", "1"))
    vad_min_silence_ms = int(os.environ.get("LOCAL_WHISPER_VAD_MIN_SILENCE_MS", "500"))

    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
    except Exception as exc:
        write_json(
            {
                "text": "",
                "error": "model_load_failed",
                "message": str(exc),
                "model": model_name,
            }
        )
        return 1

    while True:
        header = read_exact(4)
        if header is None:
            return 0
        (length,) = struct.unpack(">I", header)
        audio = read_exact(length)
        if audio is None:
            return 0
        if not audio:
            write_json({"text": "", "error": "empty_audio", "model": model_name})
            continue

        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp.write(audio)
                tmp_path = tmp.name

            segments, info = model.transcribe(
                tmp_path,
                language=language or None,
                beam_size=beam_size,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": vad_min_silence_ms},
                condition_on_previous_text=False,
                word_timestamps=False,
            )
            text = "".join(segment.text for segment in segments).strip()
            write_json(
                {
                    "text": text,
                    "language": getattr(info, "language", language),
                    "language_probability": getattr(info, "language_probability", None),
                    "model": model_name,
                }
            )
        except Exception as exc:
            write_json(
                {
                    "text": "",
                    "error": "transcription_failed",
                    "message": str(exc),
                    "model": model_name,
                }
            )
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass


if __name__ == "__main__":
    raise SystemExit(main())
