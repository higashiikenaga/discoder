import argparse
import os
import sys
from pathlib import Path

import dashscope
import requests
from dotenv import load_dotenv


MODEL_ID = "qwen3-tts-vd-2026-01-26"
VOICE_ID = "qwen-tts-vd-bailian-voice-20260510153132574-62fc"


def synthesize_to_mp3(text: str, output_path: str | Path) -> Path:
    """Synthesize text with Qwen3-TTS-Flash and save it as an MP3 file."""
    load_dotenv()
    api_key = os.getenv("DASHSCOPE_API_KEY")
    if not api_key:
        raise RuntimeError("DASHSCOPE_API_KEY is not set.")

    dashscope.api_key = api_key

    base_http_url = os.getenv("DASHSCOPE_BASE_HTTP_API_URL")
    if base_http_url:
        dashscope.base_http_api_url = base_http_url

    base_websocket_url = os.getenv("DASHSCOPE_BASE_WEBSOCKET_API_URL")
    if base_websocket_url:
        dashscope.base_websocket_api_url = base_websocket_url

    clean_text = text.strip()
    if not clean_text:
        raise ValueError("text must not be empty.")

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    response = dashscope.MultiModalConversation.call(
        model=os.getenv("QWEN_TTS_MODEL", MODEL_ID),
        api_key=api_key,
        text=clean_text,
        voice=os.getenv("QWEN_TTS_VOICE", VOICE_ID),
        language_type=os.getenv("QWEN_TTS_LANGUAGE_TYPE", "Japanese"),
        stream=False,
    )
    audio_url = extract_audio_url(response)
    if not audio_url:
        raise RuntimeError(f"Speech synthesis returned no audio URL. response={response}")

    audio_response = requests.get(audio_url, timeout=60)
    audio_response.raise_for_status()
    output.write_bytes(audio_response.content)
    return output


def extract_audio_url(response) -> str | None:
    output = getattr(response, "output", None)
    if isinstance(output, dict):
        audio = output.get("audio")
        if isinstance(audio, dict) and isinstance(audio.get("url"), str):
            return audio["url"]
        if isinstance(output.get("audio_url"), str):
            return output["audio_url"]

    if isinstance(response, dict):
        output = response.get("output", {})
        if isinstance(output, dict):
            audio = output.get("audio")
            if isinstance(audio, dict) and isinstance(audio.get("url"), str):
                return audio["url"]
            if isinstance(output.get("audio_url"), str):
                return output["audio_url"]

    return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Synthesize MP3 audio with Alibaba Cloud Qwen3-TTS-Flash.")
    parser.add_argument("text", nargs="?", help="Text to synthesize.")
    parser.add_argument("--stdin", action="store_true", help="Read text from standard input.")
    parser.add_argument("-o", "--output", default="qwen3_tts_output.mp3", help="Output MP3 path.")
    args = parser.parse_args()

    text = sys.stdin.read() if args.stdin else args.text
    if text is None:
        parser.error("text is required unless --stdin is used.")

    output = synthesize_to_mp3(text, args.output)
    print(f"Saved MP3: {output}")


if __name__ == "__main__":
    main()
