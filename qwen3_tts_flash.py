import argparse
import os
import sys
from pathlib import Path

import dashscope
from dashscope.audio.tts_v2 import SpeechSynthesizer
from dotenv import load_dotenv


MODEL_ID = "qwen3-tts-vd-flash"
VOICE_ID = "qwen-tts-vd-bailian-voice-20260510153132574-62fc"


def synthesize_to_mp3(text: str, output_path: str | Path) -> Path:
    """Synthesize text with Qwen3-TTS-Flash and save it as an MP3 file."""
    load_dotenv()
    api_key = os.getenv("DASHSCOPE_API_KEY")
    if not api_key:
        raise RuntimeError("DASHSCOPE_API_KEY is not set.")

    dashscope.api_key = api_key

    base_websocket_url = os.getenv("DASHSCOPE_BASE_WEBSOCKET_API_URL")
    if base_websocket_url:
        dashscope.base_websocket_api_url = base_websocket_url

    clean_text = text.strip()
    if not clean_text:
        raise ValueError("text must not be empty.")

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    synthesizer = SpeechSynthesizer(model=MODEL_ID, voice=VOICE_ID)
    audio = synthesizer.call(clean_text)
    if not audio:
        request_id = getattr(synthesizer, "get_last_request_id", lambda: "unknown")()
        raise RuntimeError(f"Speech synthesis returned no audio. request_id={request_id}")

    output.write_bytes(audio)
    return output


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
