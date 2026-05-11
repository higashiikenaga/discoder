import asyncio
import audioop
import base64
import io
import json
import mimetypes
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import wave
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from aiohttp import ClientSession, ClientTimeout, web
import discord
from discord import app_commands
from dotenv import load_dotenv
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build as build_google_service
from googleapiclient.http import MediaIoBaseUpload

try:
    from google import genai as google_new_genai
except ImportError:
    google_new_genai = None

try:
    import google.generativeai as google_legacy_genai
except ImportError:
    google_legacy_genai = None

try:
    from discord.ext import voice_recv
    from discord.ext.voice_recv import opus as voice_recv_opus
except ImportError:
    voice_recv = None
    voice_recv_opus = None

try:
    from google.cloud import speech
except ImportError:
    speech = None


DEFAULT_MODEL = "gemini-3.1-flash-lite-preview"
TALK_CODING_MODEL = "gemini-3-flash-preview"
TALK_CODING_TTS_MODEL = "qwen-tts-vd-bailian-voice-20260510153132574-62fc"
TALK_WAKE_WORDS = ("\u30b3\u30fc\u30c0\u30fc\u305f\u3093", "Coder\u305f\u3093", "Coder-tan")
TALK_WAKE_PATTERNS = (
    re.compile(r"(?:\u30b3\u30fc|\u3053\u30fc|\u3053\u3046)\s*(?:\u30c0\u30fc|\u3060\u30fc|\u3060)\s*(?:\u305f\u3093|\u3055\u3093|\u3061\u3083\u3093)?", re.IGNORECASE),
    re.compile(r"coder\s*(?:tan|\u305f\u3093|\u3055\u3093|\u3061\u3083\u3093)?", re.IGNORECASE),
)
TALK_COMPLETE_WORD = "\u5b8c\u6210"
TALK_SESSION_IDLE_SECONDS = 60 * 60
TALK_SESSION_CLEANUP_INTERVAL_SECONDS = 5 * 60
DISCORD_PCM_SAMPLE_RATE = 48000
DISCORD_PCM_CHANNELS = 2
DISCORD_PCM_SAMPLE_WIDTH = 2
GOOGLE_STT_SAMPLE_RATE = 16000
TALK_STT_CHUNK_SECONDS = 5
TALK_STT_MIN_INTERVAL_SECONDS = 5
TALK_STT_MIN_RMS = 180
TALK_STT_MODE_VC_RECEIVE = "vc_receive"
TALK_STT_MODE_VOICE_MESSAGE = "voice_message"
TALK_STT_MODE_NODE_BRIDGE = "node_bridge"
MODEL_CHOICES = [
    app_commands.Choice(name="gemini-3.1-flash-lite-preview", value="gemini-3.1-flash-lite-preview"),
    app_commands.Choice(name="gemini-3-flash-preview", value="gemini-3-flash-preview"),
    app_commands.Choice(name="gemini-2.5-flash-lite", value="gemini-2.5-flash-lite"),
    app_commands.Choice(name="gemini-2.5-pro", value="gemini-2.5-pro"),
]
LANGUAGE_CHOICES = [
    app_commands.Choice(name="HTML/CSS/JavaScript", value="HTML/CSS/JavaScript"),
    app_commands.Choice(name="Python", value="Python"),
    app_commands.Choice(name="Discord.py", value="Discord.py"),
    app_commands.Choice(name="JavaScript", value="JavaScript"),
    app_commands.Choice(name="TypeScript", value="TypeScript"),
    app_commands.Choice(name="React", value="React"),
    app_commands.Choice(name="Vue", value="Vue"),
    app_commands.Choice(name="Next.js", value="Next.js"),
    app_commands.Choice(name="Tailwind CSS", value="Tailwind CSS"),
    app_commands.Choice(name="Node.js", value="Node.js"),
    app_commands.Choice(name="Java", value="Java"),
    app_commands.Choice(name="C#", value="C#"),
    app_commands.Choice(name="C++", value="C++"),
    app_commands.Choice(name="Go", value="Go"),
    app_commands.Choice(name="Rust", value="Rust"),
    app_commands.Choice(name="PHP", value="PHP"),
]
MAX_DISCORD_FILE_SIZE = 24 * 1024 * 1024
GEMINI_RETRY_DELAYS = (2, 5, 10)
MAX_MEMORY_ITEMS = 12
MAX_MEMORY_TEXT = 5000
DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.file"]
DB_PATH = Path("discoder.db")
OAUTH_STATES: dict[str, int] = {}


@dataclass
class GeneratedProject:
    title: str
    summary: str
    files: list[dict[str, str]]
    preview_file: str | None
    asset_sources: list[dict[str, str]]


@dataclass
class GeneratedAttachment:
    filename: str
    content: bytes


@dataclass
class ProjectMemoryItem:
    kind: str
    user: str
    summary: str


class GeminiBusyError(RuntimeError):
    pass


PROJECT_MEMORY: dict[tuple[int, int, int], list[ProjectMemoryItem]] = {}
GOOGLE_SPEECH_CLIENT: Any | None = None
VOICE_RECV_OPUS_PATCHED = False


@dataclass
class TalkCodingSession:
    guild_id: int
    session_id: str
    owner_id: int
    text_channel_id: int
    voice_channel_id: int
    voice_client: discord.VoiceClient | None
    history: list[str]
    voice_bridge: Any | None = None
    speech_sink: Any | None = None
    finalizing: bool = False
    voice_armed_until: float = 0.0
    last_active_at: float = field(default_factory=time.monotonic)
    debug_packets_reported: set[int] = field(default_factory=set)
    response_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    stt_inflight_users: set[int] = field(default_factory=set)


def load_settings() -> tuple[str, str, int | None]:
    load_dotenv()
    discord_token = os.getenv("DISCORD_TOKEN")
    gemini_key = os.getenv("GEMINI_API_KEY")
    guild_id = os.getenv("DISCORD_GUILD_ID")

    if not discord_token:
        raise RuntimeError("DISCORD_TOKEN is not set.")
    if not gemini_key:
        raise RuntimeError("GEMINI_API_KEY is not set.")

    return discord_token, gemini_key, int(guild_id) if guild_id else None


def google_oauth_configured() -> bool:
    return bool(os.getenv("GOOGLE_CLIENT_ID") and os.getenv("GOOGLE_CLIENT_SECRET"))


def google_redirect_uri() -> str:
    explicit_uri = os.getenv("GOOGLE_REDIRECT_URI")
    if explicit_uri:
        return explicit_uri

    public_base_url = os.getenv("GOOGLE_PUBLIC_BASE_URL")
    if public_base_url:
        return f"{public_base_url.rstrip('/')}/oauth2callback"

    return "http://localhost:8080/oauth2callback"


def google_redirect_is_localhost() -> bool:
    redirect_uri = google_redirect_uri().lower()
    return "://localhost" in redirect_uri or "://127.0.0.1" in redirect_uri


def google_drive_folder_name() -> str:
    return os.getenv("GOOGLE_DRIVE_FOLDER_NAME", "DisCoder")


def talk_coding_tts_api_key() -> str | None:
    return (
        os.getenv("TALK_CODING_TTS_API_KEY")
        or os.getenv("QWEN_TTS_API_KEY")
        or os.getenv("DASHSCOPE_API_KEY")
    )


def talk_coding_tts_model() -> str:
    return os.getenv("TALK_CODING_TTS_MODEL", TALK_CODING_TTS_MODEL)


def talk_coding_tts_api_url() -> str | None:
    return os.getenv("TALK_CODING_TTS_API_URL")


def talk_coding_voice_receive_enabled() -> bool:
    if talk_coding_stt_mode() not in {TALK_STT_MODE_VC_RECEIVE, TALK_STT_MODE_NODE_BRIDGE}:
        return False
    value = os.getenv("TALK_CODING_ENABLE_VOICE_RECEIVE", "true").strip().lower()
    return value not in {"0", "false", "no", "off"}


def talk_coding_stt_mode() -> str:
    value = os.getenv("TALK_CODING_STT_MODE", TALK_STT_MODE_VC_RECEIVE).strip().lower()
    if value in {TALK_STT_MODE_NODE_BRIDGE, "node", "bridge", "discordjs"}:
        return TALK_STT_MODE_NODE_BRIDGE
    if value in {TALK_STT_MODE_VC_RECEIVE, "vc", "receive"}:
        return TALK_STT_MODE_VC_RECEIVE
    return TALK_STT_MODE_VOICE_MESSAGE


def talk_coding_debug_stt_enabled() -> bool:
    value = os.getenv("TALK_CODING_DEBUG_STT", "false").strip().lower()
    return value in {"1", "true", "yes", "on"}


def talk_coding_save_stt_audio_enabled() -> bool:
    value = os.getenv("TALK_CODING_SAVE_STT_AUDIO", "false").strip().lower()
    return value in {"1", "true", "yes", "on"}


def talk_coding_stt_language_code() -> str:
    return os.getenv("TALK_CODING_STT_LANGUAGE_CODE", "ja-JP")


def talk_coding_stt_model() -> str | None:
    return os.getenv("TALK_CODING_STT_MODEL") or None


def init_database() -> None:
    with sqlite3.connect(DB_PATH) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS google_credentials (
                discord_user_id TEXT PRIMARY KEY,
                token TEXT NOT NULL,
                refresh_token TEXT,
                token_uri TEXT NOT NULL,
                client_id TEXT NOT NULL,
                client_secret TEXT NOT NULL,
                scopes TEXT NOT NULL,
                expiry TEXT
            )
            """
        )


def create_google_flow(state: str | None = None) -> Flow:
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise RuntimeError("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.")

    flow = Flow.from_client_config(
        {
            "web": {
                "client_id": client_id,
                "client_secret": client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": [google_redirect_uri()],
            }
        },
        scopes=DRIVE_SCOPES,
        state=state,
    )
    flow.redirect_uri = google_redirect_uri()
    return flow


def save_google_credentials(discord_user_id: int, credentials: Credentials) -> None:
    with sqlite3.connect(DB_PATH) as connection:
        connection.execute(
            """
            INSERT INTO google_credentials (
                discord_user_id, token, refresh_token, token_uri, client_id,
                client_secret, scopes, expiry
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(discord_user_id) DO UPDATE SET
                token = excluded.token,
                refresh_token = COALESCE(excluded.refresh_token, google_credentials.refresh_token),
                token_uri = excluded.token_uri,
                client_id = excluded.client_id,
                client_secret = excluded.client_secret,
                scopes = excluded.scopes,
                expiry = excluded.expiry
            """,
            (
                str(discord_user_id),
                credentials.token,
                credentials.refresh_token,
                credentials.token_uri,
                credentials.client_id,
                credentials.client_secret,
                json.dumps(credentials.scopes or DRIVE_SCOPES),
                credentials.expiry.isoformat() if credentials.expiry else None,
            ),
        )


def load_google_credentials(discord_user_id: int) -> Credentials | None:
    with sqlite3.connect(DB_PATH) as connection:
        row = connection.execute(
            """
            SELECT token, refresh_token, token_uri, client_id, client_secret, scopes, expiry
            FROM google_credentials
            WHERE discord_user_id = ?
            """,
            (str(discord_user_id),),
        ).fetchone()
    if not row:
        return None

    token, refresh_token, token_uri, client_id, client_secret, scopes, expiry = row
    credentials = Credentials(
        token=token,
        refresh_token=refresh_token,
        token_uri=token_uri,
        client_id=client_id,
        client_secret=client_secret,
        scopes=json.loads(scopes),
    )
    if expiry:
        credentials.expiry = datetime.fromisoformat(expiry).replace(tzinfo=None)
    return credentials


def delete_google_credentials(discord_user_id: int) -> None:
    with sqlite3.connect(DB_PATH) as connection:
        connection.execute(
            "DELETE FROM google_credentials WHERE discord_user_id = ?",
            (str(discord_user_id),),
        )


def is_google_connected(discord_user_id: int) -> bool:
    return load_google_credentials(discord_user_id) is not None


def get_drive_service(discord_user_id: int) -> Any:
    credentials = load_google_credentials(discord_user_id)
    if credentials is None:
        return None

    if credentials.expired and credentials.refresh_token:
        credentials.refresh(GoogleAuthRequest())
        save_google_credentials(discord_user_id, credentials)
    return build_google_service("drive", "v3", credentials=credentials)


def ensure_drive_folder(service: Any) -> str:
    folder_name = google_drive_folder_name()
    escaped_name = folder_name.replace("'", "\\'")
    result = (
        service.files()
        .list(
            q=(
                f"name = '{escaped_name}' and "
                "mimeType = 'application/vnd.google-apps.folder' and trashed = false"
            ),
            spaces="drive",
            fields="files(id, name)",
            pageSize=1,
        )
        .execute()
    )
    files = result.get("files", [])
    if files:
        return files[0]["id"]

    folder = (
        service.files()
        .create(
            body={"name": folder_name, "mimeType": "application/vnd.google-apps.folder"},
            fields="id",
        )
        .execute()
    )
    return folder["id"]


def upload_attachment_to_drive(service: Any, folder_id: str, attachment: GeneratedAttachment) -> str:
    mime_type = mimetypes.guess_type(attachment.filename)[0] or "application/octet-stream"
    media = MediaIoBaseUpload(io.BytesIO(attachment.content), mimetype=mime_type, resumable=False)
    created = (
        service.files()
        .create(
            body={"name": attachment.filename, "parents": [folder_id]},
            media_body=media,
            fields="id, name, webViewLink",
        )
        .execute()
    )
    return created.get("webViewLink", f"https://drive.google.com/file/d/{created['id']}/view")


async def upload_generated_attachments_to_drive(
    discord_user_id: int,
    attachments: list[GeneratedAttachment],
) -> list[str]:
    def upload_all() -> list[str]:
        service = get_drive_service(discord_user_id)
        if service is None:
            return []
        folder_id = ensure_drive_folder(service)
        return [upload_attachment_to_drive(service, folder_id, attachment) for attachment in attachments]

    return await asyncio.to_thread(upload_all)


async def handle_oauth_callback(request: web.Request) -> web.Response:
    state = request.query.get("state")
    code = request.query.get("code")
    if not state or not code or state not in OAUTH_STATES:
        return web.Response(text="Invalid or expired OAuth state.", status=400)

    discord_user_id = OAUTH_STATES.pop(state)
    try:
        flow = create_google_flow(state)
        flow.fetch_token(code=code)
        save_google_credentials(discord_user_id, flow.credentials)
    except Exception as exc:
        return web.Response(text=f"Google Drive connection failed: {exc}", status=500)

    return web.Response(text="Google Drive connection completed. You can return to Discord.")


async def start_oauth_server() -> tuple[web.AppRunner, web.TCPSite] | None:
    if not google_oauth_configured():
        return None

    host = os.getenv("GOOGLE_OAUTH_HOST", "0.0.0.0")
    port = int(os.getenv("GOOGLE_OAUTH_PORT", "8080"))
    app = web.Application()
    app.router.add_get("/oauth2callback", handle_oauth_callback)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    return runner, site


def build_memory_context(interaction: discord.Interaction) -> str:
    key = memory_key(interaction)
    items = PROJECT_MEMORY.get(key, [])
    if not items:
        return "No previous project context is known for this user in this channel."

    lines = ["Known project context from this user's previous bot interactions in this channel:"]
    for item in items[-MAX_MEMORY_ITEMS:]:
        lines.append(f"- [{item.kind}] {item.user}: {item.summary}")
    context = "\n".join(lines)
    return context[-MAX_MEMORY_TEXT:]


def memory_key(interaction: discord.Interaction) -> tuple[int, int, int]:
    guild_id = interaction.guild_id or 0
    channel_id = interaction.channel_id or 0
    return guild_id, channel_id, interaction.user.id


def remember_project(interaction: discord.Interaction, kind: str, summary: str) -> None:
    key = memory_key(interaction)
    items = PROJECT_MEMORY.setdefault(key, [])
    clean_summary = re.sub(r"\s+", " ", summary).strip()
    items.append(ProjectMemoryItem(kind=kind, user=interaction.user.display_name, summary=clean_summary[:700]))
    del items[:-MAX_MEMORY_ITEMS]


def build_prompt(content: str, programming_language: str, project_context: str) -> str:
    return f"""
You are a senior software engineer generating a complete, runnable coding result.

Project context:
{project_context}

User request:
{content}

Requested programming language or framework:
{programming_language}

Return only valid JSON with this exact schema:
{{
  "title": "short project title",
  "summary": "short Japanese summary for the Discord response",
  "preview_file": "relative path to an HTML file to screenshot, or null",
  "asset_sources": [
    {{
      "asset": "image or external visual asset name/path/url",
      "source": "source name and direct URL, or 'none' when no external visual assets are used",
      "license": "license or usage note if known"
    }}
  ],
  "files": [
    {{
      "path": "relative/file/path.ext",
      "content": "full file content"
    }}
  ]
}}

Rules:
- Do not wrap the JSON in markdown.
- Generate complete code, not fragments.
- Use the project context when it is relevant, but do not invent missing files or requirements.
- If the result is a web UI, include a directly previewable HTML file and set preview_file to it.
- For React/Vue/Svelte or other UI framework requests, include a simple static preview HTML when possible so it can be screenshotted without installing dependencies.
- If you use any external image, icon, font, CDN image, placeholder image, or other visual asset, list it in asset_sources with a direct source URL.
- If no external visual assets are used, set asset_sources to one entry whose asset is "external visual assets" and source is "none".
- Prefer CSS-drawn UI, inline code, or clearly attributed public assets over unexplained image URLs.
- Keep file paths relative. Do not use absolute paths. Do not use .. segments.
- Include a README when setup or run commands are useful.
""".strip()


def extract_json(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped)
        stripped = re.sub(r"\s*```$", "", stripped)

    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", stripped, flags=re.DOTALL)
        if not match:
            raise
        return json.loads(match.group(0))


def validate_project(data: dict[str, Any]) -> GeneratedProject:
    files = data.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError("Gemini response did not include files.")

    clean_files: list[dict[str, str]] = []
    for item in files:
        path = item.get("path") if isinstance(item, dict) else None
        content = item.get("content") if isinstance(item, dict) else None
        if not isinstance(path, str) or not isinstance(content, str):
            raise ValueError("Gemini response included an invalid file entry.")
        candidate = Path(path)
        if candidate.is_absolute() or ".." in candidate.parts:
            raise ValueError(f"Unsafe generated file path: {path}")
        clean_files.append({"path": path.replace("\\", "/"), "content": content})

    preview_file = data.get("preview_file")
    if preview_file is not None:
        if not isinstance(preview_file, str):
            preview_file = None
        else:
            candidate = Path(preview_file)
            if candidate.is_absolute() or ".." in candidate.parts:
                preview_file = None

    asset_sources = normalize_asset_sources(data.get("asset_sources"))
    title = data.get("title") if isinstance(data.get("title"), str) else "generated-code"
    summary = data.get("summary") if isinstance(data.get("summary"), str) else "コードを生成しました。"
    return GeneratedProject(
        title=title,
        summary=summary,
        files=clean_files,
        preview_file=preview_file,
        asset_sources=asset_sources,
    )


def normalize_asset_sources(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return [{"asset": "external visual assets", "source": "not provided", "license": "unknown"}]

    sources: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        asset = item.get("asset")
        source = item.get("source")
        license_note = item.get("license")
        if isinstance(asset, str) and isinstance(source, str):
            sources.append(
                {
                    "asset": asset.strip() or "unknown asset",
                    "source": source.strip() or "not provided",
                    "license": license_note.strip() if isinstance(license_note, str) else "unknown",
                }
            )

    return sources or [{"asset": "external visual assets", "source": "not provided", "license": "unknown"}]


def create_gemini_client(api_key: str) -> Any:
    if google_new_genai is not None:
        return google_new_genai.Client(api_key=api_key)
    if google_legacy_genai is not None:
        google_legacy_genai.configure(api_key=api_key)
        return google_legacy_genai
    raise RuntimeError("Gemini SDK is not installed. Run: pip install -r requirements.txt")


def is_retryable_gemini_error(exc: Exception) -> bool:
    message = str(exc).lower()
    retryable_markers = (
        "503",
        "unavailable",
        "high demand",
        "resource_exhausted",
        "429",
        "rate limit",
        "temporarily",
    )
    return any(marker in message for marker in retryable_markers)


async def request_gemini_content(
    client: Any,
    prompt: str,
    model_name: str,
    response_mime_type: str | None = None,
) -> str:
    last_error: Exception | None = None

    for attempt in range(len(GEMINI_RETRY_DELAYS) + 1):
        try:
            if google_new_genai is not None and hasattr(client, "models"):
                kwargs = {"model": model_name, "contents": prompt}
                if response_mime_type:
                    kwargs["config"] = {"response_mime_type": response_mime_type}
                response = await asyncio.to_thread(client.models.generate_content, **kwargs)
            else:
                kwargs = {"model_name": model_name}
                if response_mime_type:
                    kwargs["generation_config"] = {"response_mime_type": response_mime_type}
                model = client.GenerativeModel(**kwargs)
                response = await asyncio.to_thread(model.generate_content, prompt)
            return response.text or ""
        except Exception as exc:
            if not is_retryable_gemini_error(exc):
                raise
            last_error = exc
            if attempt >= len(GEMINI_RETRY_DELAYS):
                break
            await asyncio.sleep(GEMINI_RETRY_DELAYS[attempt])

    raise GeminiBusyError(
        f"{model_name} が混雑しています。数十秒から数分後にもう一度実行してください。"
    ) from last_error


async def generate_project(
    client: Any,
    content: str,
    programming_language: str,
    model_name: str,
    project_context: str,
) -> GeneratedProject:
    prompt = build_prompt(content, programming_language, project_context)
    response_text = await request_gemini_content(client, prompt, model_name, "application/json")
    data = extract_json(response_text)
    return validate_project(data)


async def generate_text_response(client: Any, prompt: str, model_name: str) -> str:
    response = await request_gemini_content(client, prompt, model_name)
    return response.strip() or "回答を生成できませんでした。"


def build_review_prompt(code: str, programming_language: str, project_context: str) -> str:
    return f"""
You are a strict senior code reviewer.

Project context:
{project_context}

Language/framework:
{programming_language}

Review this code:
```{programming_language}
{code}
```

Respond in Japanese. Lead with concrete findings ordered by severity.
Include:
- Bugs or likely runtime errors
- Security, reliability, or maintainability risks
- Missing tests or edge cases
- Specific fix suggestions

If there are no serious issues, say that clearly and mention remaining risks.
Keep the response concise enough for Discord.
""".strip()


def build_debug_prompt(error_text: str, code: str | None, programming_language: str, project_context: str) -> str:
    code_block = f"\nRelated code:\n```{programming_language}\n{code}\n```" if code else ""
    return f"""
You are a debugging assistant for software engineers.

Project context:
{project_context}

Language/framework:
{programming_language}

Error/log:
```text
{error_text}
```
{code_block}

Respond in Japanese. Explain:
- Most likely cause
- Why that cause matches the error
- What to check next
- Concrete fix steps
- A corrected code snippet if useful

Do not overstate certainty when the pasted information is incomplete.
""".strip()


def build_feature_prompt(feature: str, programming_language: str, project_context: str) -> str:
    return f"""
Generate a feature-sized implementation that fits the known project.

Project context:
{project_context}

Requested feature:
{feature}

Language/framework:
{programming_language}

Return complete runnable files as JSON using the required schema.
Prefer a focused feature patch over a full unrelated app rewrite.
""".strip()


def write_project(project: GeneratedProject, target_dir: Path) -> None:
    for file in project.files:
        destination = target_dir / file["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(file["content"], encoding="utf-8")
    write_asset_sources(project, target_dir)


def discover_visual_asset_urls(project: GeneratedProject) -> list[str]:
    pattern = re.compile(
        r"https?://[^\s\"'<>]+\.(?:png|jpe?g|gif|webp|svg|avif)(?:\?[^\s\"'<>]*)?",
        flags=re.IGNORECASE,
    )
    urls: set[str] = set()
    for file in project.files:
        urls.update(pattern.findall(file["content"]))
    return sorted(urls)


def write_asset_sources(project: GeneratedProject, target_dir: Path) -> None:
    detected_urls = discover_visual_asset_urls(project)
    lines = [
        "# Asset Sources",
        "",
        "Generated code must keep image and visual asset origins visible.",
        "",
        "## Declared Sources",
        "",
    ]

    for source in project.asset_sources:
        lines.append(f"- Asset: {source['asset']}")
        lines.append(f"  Source: {source['source']}")
        lines.append(f"  License/Note: {source['license']}")

    lines.extend(["", "## Detected Image URLs", ""])
    if detected_urls:
        lines.extend(f"- {url}" for url in detected_urls)
    else:
        lines.append("- No external image URLs detected in generated files.")

    (target_dir / "ASSET_SOURCES.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def make_zip(source_dir: Path, output_path: Path) -> None:
    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in source_dir.rglob("*"):
            if path.is_file():
                archive.write(path, path.relative_to(source_dir))


def find_preview_file(project: GeneratedProject, project_dir: Path) -> Path | None:
    if project.preview_file:
        candidate = project_dir / project.preview_file
        if candidate.exists() and candidate.suffix.lower() in {".html", ".htm"}:
            return candidate

    html_files = sorted(project_dir.rglob("*.html"))
    return html_files[0] if html_files else None


async def screenshot_html(html_file: Path, output_path: Path) -> bool:
    from playwright.async_api import async_playwright

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch()
        page = await browser.new_page(viewport={"width": 1366, "height": 768}, device_scale_factor=1)
        await page.goto(html_file.resolve().as_uri(), wait_until="networkidle")
        await page.screenshot(path=str(output_path), full_page=True)
        await browser.close()
    return output_path.exists()


def safe_name(value: str) -> str:
    name = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-")
    return name[:48] or "generated-code"


def make_discord_files(attachments: list[GeneratedAttachment]) -> list[discord.File]:
    return [
        discord.File(io.BytesIO(attachment.content), filename=attachment.filename)
        for attachment in attachments
    ]


def split_discord_message(message: str, limit: int = 1900) -> list[str]:
    if len(message) <= limit:
        return [message]

    chunks: list[str] = []
    remaining = message
    while remaining:
        if len(remaining) <= limit:
            chunks.append(remaining)
            break
        split_at = remaining.rfind("\n", 0, limit)
        if split_at < limit // 2:
            split_at = limit
        chunks.append(remaining[:split_at].strip())
        remaining = remaining[split_at:].strip()
    return chunks


async def attachment_to_text(attachment: discord.Attachment | None) -> str:
    if attachment is None:
        return ""
    if attachment.size > 512 * 1024:
        raise ValueError("添付ファイルが大きすぎます。512KB以下のテキストファイルにしてください。")

    data = await attachment.read()
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("cp932", errors="replace")


async def send_publishable_text(
    interaction: discord.Interaction,
    message: str,
    owner_id: int,
) -> None:
    chunks = split_discord_message(message)
    view = PublishView(owner_id, message[:2000], [])
    await interaction.followup.send(content=chunks[0], view=view, ephemeral=True)
    for chunk in chunks[1:]:
        await interaction.followup.send(content=chunk, ephemeral=True)


def extract_talk_request(message: discord.Message) -> str:
    content = message.content
    if message.guild and message.guild.me:
        content = content.replace(message.guild.me.mention, "")
    for channel in message.channel_mentions:
        content = content.replace(channel.mention, "")
    content = re.sub(r"\s+", " ", content).strip()
    return content


def find_requested_voice_channel(message: discord.Message) -> discord.VoiceChannel | discord.StageChannel | None:
    for channel in message.channel_mentions:
        if isinstance(channel, (discord.VoiceChannel, discord.StageChannel)):
            return channel
    if isinstance(message.channel, (discord.VoiceChannel, discord.StageChannel)):
        return message.channel
    if isinstance(message.author, discord.Member) and message.author.voice and message.author.voice.channel:
        channel = message.author.voice.channel
        if isinstance(channel, (discord.VoiceChannel, discord.StageChannel)):
            return channel
    return None


PII_PATTERNS = (
    re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"),
    re.compile(r"\b(?:\d[ -]?){10,16}\b"),
    re.compile(r"(api[_-]?key|token|password|secret)\s*[:=]", re.IGNORECASE),
)
PROBLEMATIC_PATTERNS = (
    re.compile(r"(殺す|死ね|爆破|脅迫|差別|ヘイト|個人情報|住所|電話番号|パスワード|トークン)"),
)


def validate_talk_text(text: str) -> tuple[bool, str | None]:
    for pattern in PII_PATTERNS:
        if pattern.search(text):
            return False, "個人情報や秘密情報らしき内容が含まれているため、音声返信はしません。"
    for pattern in PROBLEMATIC_PATTERNS:
        if pattern.search(text):
            return False, "問題発言や危険な内容の可能性があるため、音声返信はしません。"
    return True, None


def build_talk_coding_prompt(user_text: str) -> str:
    return f"""
You are Coder-tan, a concise Japanese voice coding assistant inside a Discord voice channel.

User speech or VC chat:
{user_text}

Rules:
- Reply in Japanese.
- If the user asks for code, generate useful code with the Gemini model's best judgment.
- Keep the answer short enough for TTS, but include essential code snippets when helpful.
- Do not repeat private information or unsafe content.
- If the request is ambiguous, ask one concrete clarification.
""".strip()


def user_is_in_session_voice(session: TalkCodingSession, user: discord.Member | discord.User) -> bool:
    if not isinstance(user, discord.Member):
        return False
    return bool(user.voice and user.voice.channel and user.voice.channel.id == session.voice_channel_id)


def session_voice_connected(session: TalkCodingSession) -> bool:
    if session.voice_bridge is not None:
        return getattr(session.voice_bridge, "is_running", lambda: False)()
    return bool(session.voice_client and session.voice_client.is_connected())


def resolve_session_member(bot_ref: discord.Client, session: TalkCodingSession, user: discord.Member | discord.User) -> discord.Member | None:
    if isinstance(user, discord.Member):
        return user
    guild = bot_ref.get_guild(session.guild_id)
    if guild is None:
        return None
    return guild.get_member(user.id)


def session_channel_matches(session: TalkCodingSession, channel: discord.abc.Messageable) -> bool:
    return getattr(channel, "id", None) == session.text_channel_id


def has_talk_wake_word(text: str) -> bool:
    normalized = normalize_talk_text(text)
    return any(word.lower() in normalized for word in TALK_WAKE_WORDS) or any(
        pattern.search(normalized) for pattern in TALK_WAKE_PATTERNS
    )


def strip_talk_wake_word(text: str) -> str:
    stripped = text.strip()
    literal_pattern = "|".join(re.escape(word) for word in TALK_WAKE_WORDS)
    stripped = re.sub(rf"^({literal_pattern})[\u3001!！\s]*", "", stripped, flags=re.IGNORECASE).strip()
    for pattern in TALK_WAKE_PATTERNS:
        stripped = pattern.sub("", stripped, count=1).strip()
    return re.sub(r"^[\u3001、!！\s]+", "", stripped).strip()


def normalize_talk_text(text: str) -> str:
    normalized = text.lower()
    normalized = re.sub(r"[\s\u3000、。!！?？・ー\-]+", "", normalized)
    return normalized


def is_talk_complete_request(text: str) -> bool:
    return TALK_COMPLETE_WORD in text


def is_talk_leave_request(text: str) -> bool:
    return bool(re.search(r"\b(leave|disconnect|stop)\b|\u7d42\u4e86|\u9000\u51fa|\u5207\u65ad", text, re.IGNORECASE))


def patch_voice_recv_opus_decoder() -> None:
    global VOICE_RECV_OPUS_PATCHED
    if VOICE_RECV_OPUS_PATCHED or voice_recv_opus is None:
        return

    original_decode_packet = voice_recv_opus.PacketDecoder._decode_packet

    def safe_decode_packet(self: Any, packet: Any) -> tuple[Any, bytes]:
        try:
            return original_decode_packet(self, packet)
        except discord.opus.OpusError:
            try:
                assert self._decoder is not None
                return packet, self._decoder.decode(None, fec=False)
            except Exception:
                return packet, b"\x00" * (discord.opus.Decoder.SAMPLES_PER_FRAME * discord.opus.Decoder.CHANNELS * 2)

    voice_recv_opus.PacketDecoder._decode_packet = safe_decode_packet
    VOICE_RECV_OPUS_PATCHED = True


async def synthesize_talk_tts(text: str) -> bytes | None:
    api_key = talk_coding_tts_api_key()
    api_url = talk_coding_tts_api_url()
    if not api_key or not api_url:
        return None

    payload = {
        "model": talk_coding_tts_model(),
        "input": {"text": text},
        "parameters": {"format": "mp3"},
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-DashScope-SSE": "disable",
    }
    timeout = ClientTimeout(total=60)
    async with ClientSession(timeout=timeout) as session:
        async with session.post(api_url, headers=headers, json=payload) as response:
            body = await response.read()
            if response.status >= 400:
                raise RuntimeError(f"TTS API returned HTTP {response.status}: {body[:300]!r}")
            content_type = response.headers.get("Content-Type", "")
            if "application/json" not in content_type:
                return body

    data = json.loads(body.decode("utf-8"))
    audio = data.get("audio") or data.get("output", {}).get("audio") or data.get("output", {}).get("result")
    if isinstance(audio, str):
        if audio.startswith("data:"):
            audio = audio.split(",", 1)[-1]
        try:
            return base64.b64decode(audio)
        except Exception:
            return None
    if isinstance(audio, dict):
        raw = audio.get("data") or audio.get("base64")
        if isinstance(raw, str):
            return base64.b64decode(raw)
    return None


async def play_talk_tts(voice_client: discord.VoiceClient, text: str) -> bool:
    audio = await synthesize_talk_tts(text)
    if not audio:
        return False

    path = Path(tempfile.gettempdir()) / f"discoder-tts-{secrets.token_hex(8)}.mp3"
    path.write_bytes(audio)

    if voice_client.is_playing():
        voice_client.stop()

    def cleanup(error: Exception | None) -> None:
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass

    voice_client.play(discord.FFmpegPCMAudio(str(path)), after=cleanup)
    return True


async def play_session_tts(session: TalkCodingSession, text: str) -> bool:
    audio = await synthesize_talk_tts(text)
    if not audio:
        return False
    if session.voice_bridge is not None:
        session.voice_bridge.send({"type": "play", "audio_base64": base64.b64encode(audio).decode("ascii")})
        return True
    if session.voice_client is None:
        return False

    path = Path(tempfile.gettempdir()) / f"discoder-tts-{secrets.token_hex(8)}.mp3"
    path.write_bytes(audio)
    if session.voice_client.is_playing():
        session.voice_client.stop()

    def cleanup(error: Exception | None) -> None:
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass

    session.voice_client.play(discord.FFmpegPCMAudio(str(path)), after=cleanup)
    return True


def stereo_pcm_to_mono_linear16(pcm: bytes) -> bytes:
    if len(pcm) < 4:
        return pcm
    return audioop.tomono(pcm, DISCORD_PCM_SAMPLE_WIDTH, 0.5, 0.5)


def mono_pcm_to_wav_bytes(mono_pcm: bytes, sample_rate: int = DISCORD_PCM_SAMPLE_RATE) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(DISCORD_PCM_SAMPLE_WIDTH)
        wav.setframerate(sample_rate)
        wav.writeframes(mono_pcm)
    return output.getvalue()


def pcm_rms_linear16(pcm: bytes) -> int:
    if not pcm:
        return 0
    return audioop.rms(pcm, DISCORD_PCM_SAMPLE_WIDTH)


def save_debug_stt_wav(mono_pcm: bytes) -> Path:
    path = Path(tempfile.gettempdir()) / f"discoder-stt-{secrets.token_hex(8)}.wav"
    path.write_bytes(mono_pcm_to_wav_bytes(mono_pcm))
    return path


def save_debug_raw_variants(pcm: bytes) -> list[Path]:
    base = Path(tempfile.gettempdir()) / f"discoder-stt-variants-{secrets.token_hex(8)}"
    paths: list[Path] = []
    variants: list[tuple[str, bytes, int, int]] = [
        ("stereo-48k", pcm, 2, 48000),
        ("stereo-24k", pcm, 2, 24000),
        ("mono-mixed-48k", stereo_pcm_to_mono_linear16(pcm), 1, 48000),
        ("mono-mixed-24k", stereo_pcm_to_mono_linear16(pcm), 1, 24000),
    ]
    left = audioop.tomono(pcm, DISCORD_PCM_SAMPLE_WIDTH, 1.0, 0.0) if len(pcm) >= 4 else pcm
    right = audioop.tomono(pcm, DISCORD_PCM_SAMPLE_WIDTH, 0.0, 1.0) if len(pcm) >= 4 else pcm
    variants.extend(
        [
            ("left-48k", left, 1, 48000),
            ("right-48k", right, 1, 48000),
        ]
    )
    for name, data, channels, sample_rate in variants:
        path = base.with_name(f"{base.name}-{name}.wav")
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(channels)
            wav.setsampwidth(DISCORD_PCM_SAMPLE_WIDTH)
            wav.setframerate(sample_rate)
            wav.writeframes(data)
        paths.append(path)
    return paths


def pcm_to_flac_16khz(mono_pcm: bytes) -> bytes:
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "s16le",
        "-ar",
        str(DISCORD_PCM_SAMPLE_RATE),
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-ar",
        str(GOOGLE_STT_SAMPLE_RATE),
        "-ac",
        "1",
        "-f",
        "flac",
        "pipe:1",
    ]
    completed = subprocess.run(command, input=mono_pcm, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    return completed.stdout


def audio_file_to_flac_16khz(audio_data: bytes) -> bytes:
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-ar",
        str(GOOGLE_STT_SAMPLE_RATE),
        "-ac",
        "1",
        "-f",
        "flac",
        "pipe:1",
    ]
    completed = subprocess.run(command, input=audio_data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    return completed.stdout


async def transcribe_audio_file_data(audio_data: bytes) -> str | None:
    if not audio_data or speech is None:
        return None
    try:
        flac_audio = await asyncio.to_thread(audio_file_to_flac_16khz, audio_data)
        response = await asyncio.to_thread(recognize_google_cloud_speech, flac_audio)
    except Exception as exc:
        print(f"Cloud Speech-to-Text file transcription failed: {exc}")
        return None

    transcripts = [
        result.alternatives[0].transcript.strip()
        for result in response.results
        if result.alternatives and result.alternatives[0].transcript.strip()
    ]
    return " ".join(transcripts).strip() or None


def is_audio_attachment(attachment: discord.Attachment) -> bool:
    content_type = (attachment.content_type or "").lower()
    suffix = Path(attachment.filename).suffix.lower()
    return content_type.startswith("audio/") or suffix in {".ogg", ".oga", ".opus", ".mp3", ".m4a", ".wav", ".webm"}


async def transcribe_talk_audio(pcm: bytes) -> str | None:
    if not pcm or speech is None:
        return None

    mono_pcm = stereo_pcm_to_mono_linear16(pcm)
    if pcm_rms_linear16(mono_pcm) < TALK_STT_MIN_RMS:
        return None
    if talk_coding_save_stt_audio_enabled():
        print(f"Saved STT debug wav: {save_debug_stt_wav(mono_pcm)}")
        print("Saved STT debug variants:")
        for path in save_debug_raw_variants(pcm):
            print(f"  {path}")

    try:
        flac_audio = await asyncio.to_thread(pcm_to_flac_16khz, mono_pcm)
        response = await asyncio.to_thread(recognize_google_cloud_speech, flac_audio)
    except Exception as exc:
        print(f"Cloud Speech-to-Text failed: {exc}")
        return None

    transcripts = [
        result.alternatives[0].transcript.strip()
        for result in response.results
        if result.alternatives and result.alternatives[0].transcript.strip()
    ]
    return " ".join(transcripts).strip() or None


def recognize_google_cloud_speech(flac_audio: bytes) -> Any:
    global GOOGLE_SPEECH_CLIENT
    if GOOGLE_SPEECH_CLIENT is None:
        GOOGLE_SPEECH_CLIENT = speech.SpeechClient()
    config_kwargs: dict[str, Any] = {
        "encoding": speech.RecognitionConfig.AudioEncoding.FLAC,
        "sample_rate_hertz": GOOGLE_STT_SAMPLE_RATE,
        "language_code": talk_coding_stt_language_code(),
        "audio_channel_count": 1,
        "enable_automatic_punctuation": True,
    }
    model = talk_coding_stt_model()
    if model:
        config_kwargs["model"] = model

    config = speech.RecognitionConfig(**config_kwargs)
    audio = speech.RecognitionAudio(content=flac_audio)
    return GOOGLE_SPEECH_CLIENT.recognize(config=config, audio=audio)


if voice_recv is not None:

    class TalkCodingSpeechSink(voice_recv.AudioSink):
        def __init__(self, bot_ref: "CoderBot", guild_id: int, loop: asyncio.AbstractEventLoop) -> None:
            super().__init__()
            self.bot_ref = bot_ref
            self.guild_id = guild_id
            self.loop = loop
            self.buffers: dict[int, bytearray] = {}
            self.last_packet_at: dict[int, float] = {}
            self.last_transcribed_at: dict[int, float] = {}

        def wants_opus(self) -> bool:
            return False

        @voice_recv.AudioSink.listener()
        def on_speaking_start(self, user: discord.Member | discord.User) -> None:
            if not talk_coding_debug_stt_enabled():
                return
            session = self.bot_ref.talk_sessions.get(self.guild_id)
            if not session:
                return
            member = resolve_session_member(self.bot_ref, session, user)
            name = member.display_name if member else getattr(user, "display_name", str(user))
            self.loop.call_soon_threadsafe(
                lambda: asyncio.create_task(self.bot_ref.report_talk_debug(self.guild_id, f"[STT] speaking: {name}"))
            )

        def write(self, user: discord.Member | discord.User | None, data: Any) -> None:
            if user is None or user.bot:
                return
            session = self.bot_ref.talk_sessions.get(self.guild_id)
            if not session or session.finalizing:
                return
            member = resolve_session_member(self.bot_ref, session, user)
            if member is None or not user_is_in_session_voice(session, member):
                return
            if member.id in session.stt_inflight_users:
                return
            pcm = getattr(data, "pcm", None)
            if not pcm:
                return
            user_id = member.id
            if talk_coding_debug_stt_enabled() and user_id not in session.debug_packets_reported:
                session.debug_packets_reported.add(user_id)
                self.loop.call_soon_threadsafe(
                    lambda: asyncio.create_task(
                        self.bot_ref.report_talk_debug(session.guild_id, f"[STT] audio packets received from {member.display_name}")
                    )
                )
            buffer = self.buffers.setdefault(user_id, bytearray())
            buffer.extend(pcm)
            now = time.monotonic()
            self.last_packet_at[user_id] = now
            last = self.last_transcribed_at.get(user_id, 0.0)
            chunk_size = DISCORD_PCM_SAMPLE_RATE * DISCORD_PCM_CHANNELS * DISCORD_PCM_SAMPLE_WIDTH * TALK_STT_CHUNK_SECONDS
            max_buffer_size = chunk_size * 3
            if len(buffer) >= chunk_size and now - last >= TALK_STT_MIN_INTERVAL_SECONDS:
                self.last_transcribed_at[user_id] = now
                chunk = bytes(buffer)
                buffer.clear()
                self.loop.call_soon_threadsafe(
                    lambda: asyncio.create_task(self.bot_ref.handle_talk_coding_audio(self.guild_id, member, chunk))
                )
            elif len(buffer) > max_buffer_size:
                del buffer[: len(buffer) - chunk_size]

        def cleanup(self) -> None:
            self.buffers.clear()
            self.last_packet_at.clear()
            self.last_transcribed_at.clear()

else:
    TalkCodingSpeechSink = None


class NodeVoiceBridge:
    def __init__(
        self,
        bot_ref: "CoderBot",
        guild_id: int,
        voice_channel_id: int,
        text_channel_id: int,
    ) -> None:
        self.bot_ref = bot_ref
        self.guild_id = guild_id
        self.voice_channel_id = voice_channel_id
        self.text_channel_id = text_channel_id
        self.process: subprocess.Popen[str] | None = None
        self.reader_thread: threading.Thread | None = None

    def start(self) -> None:
        script = Path(__file__).with_name("voice_bridge_node.js")
        if not script.exists():
            raise RuntimeError("voice_bridge_node.js was not found.")
        env = os.environ.copy()
        env.update(
            {
                "VOICE_BRIDGE_GUILD_ID": str(self.guild_id),
                "VOICE_BRIDGE_CHANNEL_ID": str(self.voice_channel_id),
                "VOICE_BRIDGE_STT_LANGUAGE": talk_coding_stt_language_code(),
            }
        )
        self.process = subprocess.Popen(
            ["node", str(script)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            env=env,
            cwd=str(Path(__file__).parent),
        )
        self.reader_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self.reader_thread.start()

    def is_running(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def send(self, payload: dict[str, Any]) -> None:
        if not self.process or not self.process.stdin or self.process.poll() is not None:
            return
        self.process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def stop(self) -> None:
        self.send({"type": "stop"})
        if self.process and self.process.poll() is None:
            try:
                self.process.terminate()
            except Exception:
                pass

    def _read_stdout(self) -> None:
        if not self.process or not self.process.stdout:
            return
        for line in self.process.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                print(f"[voice-bridge] {line}")
                continue
            self.bot_ref.loop.call_soon_threadsafe(
                lambda item=payload: asyncio.create_task(self.bot_ref.handle_node_bridge_event(self.guild_id, item))
            )


async def build_project_attachments(
    project: GeneratedProject,
    work_root: Path,
    history: list[str] | None = None,
) -> list[GeneratedAttachment]:
    project_dir = work_root / "project"
    project_dir.mkdir(parents=True, exist_ok=True)
    write_project(project, project_dir)

    zip_path = work_root / f"{safe_name(project.title)}.zip"
    make_zip(project_dir, zip_path)
    if zip_path.stat().st_size > MAX_DISCORD_FILE_SIZE:
        raise ValueError("Generated zip is larger than Discord's upload limit.")

    attachments = [GeneratedAttachment(filename=zip_path.name, content=zip_path.read_bytes())]
    preview = find_preview_file(project, project_dir)
    if preview:
        screenshot_path = work_root / "preview.png"
        if await screenshot_html(preview, screenshot_path):
            attachments.append(GeneratedAttachment(filename="preview.png", content=screenshot_path.read_bytes()))
    return attachments


def build_talk_final_prompt(history: list[str]) -> str:
    conversation = "\n".join(history[-40:])
    return f"""
Create the final completed files for this Discord VC talk-coding session.

Conversation transcript:
{conversation}

Requirements:
- Use the actual requests and code decisions from the transcript.
- Return complete runnable files as JSON using the required schema.
- Include a concise Japanese summary.
- Include useful README setup/run instructions.
- If the result is a web UI, include a previewable HTML file so the bot can post a screenshot.
""".strip()


def summarize_asset_sources(project: GeneratedProject) -> str:
    detected_urls = discover_visual_asset_urls(project)
    declared = [
        source
        for source in project.asset_sources
        if source["source"].lower() not in {"none", "なし", "not provided"}
    ]

    if not declared and not detected_urls:
        return "画像/外部ビジュアル出典: 外部画像URLは検出されませんでした。"

    parts: list[str] = []
    for source in declared[:3]:
        parts.append(f"{source['asset']} - {source['source']}")
    for url in detected_urls[:3]:
        if url not in " ".join(parts):
            parts.append(url)

    suffix = " ほか" if len(declared) + len(detected_urls) > 3 else ""
    return f"画像/外部ビジュアル出典: {' / '.join(parts[:3])}{suffix}"


async def build_drive_save_summary(
    discord_user_id: int,
    attachments: list[GeneratedAttachment],
) -> str:
    if not google_oauth_configured():
        return ""
    if not is_google_connected(discord_user_id):
        return "\nGoogle Drive: 未連携です。`/drive connect` で連携できます。"

    try:
        links = await upload_generated_attachments_to_drive(discord_user_id, attachments)
    except Exception as exc:
        return f"\nGoogle Drive: 保存に失敗しました (`{exc}`)"

    if not links:
        return "\nGoogle Drive: 未連携です。`/drive connect` で連携できます。"

    link_lines = "\n".join(f"- {link}" for link in links[:5])
    suffix = "\n- ほか" if len(links) > 5 else ""
    return f"\nGoogle Drive: 保存しました。\n{link_lines}{suffix}"


class PublishView(discord.ui.View):
    def __init__(self, owner_id: int, message: str, attachments: list[GeneratedAttachment]) -> None:
        super().__init__(timeout=3600)
        self.owner_id = owner_id
        self.message = message
        self.attachments = attachments
        self.published = False

    @discord.ui.button(label="公開", style=discord.ButtonStyle.primary)
    async def publish(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        if interaction.user.id != self.owner_id:
            await interaction.response.send_message("この生成結果を公開できるのは実行者だけです。", ephemeral=True)
            return
        if self.published:
            await interaction.response.send_message("この生成結果はすでに公開済みです。", ephemeral=True)
            return
        if interaction.channel is None:
            await interaction.response.send_message("この場所では公開できません。", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        await interaction.channel.send(content=self.message, files=make_discord_files(self.attachments))
        self.published = True
        button.disabled = True
        await interaction.edit_original_response(view=self)
        await interaction.followup.send("公開しました。", ephemeral=True)


class CoderBot(discord.Client):
    def __init__(self, gemini_key: str, guild_id: int | None) -> None:
        intents = discord.Intents.default()
        intents.guilds = True
        intents.guild_messages = True
        intents.message_content = True
        intents.voice_states = True
        super().__init__(intents=intents)
        self.tree = app_commands.CommandTree(self)
        self.gemini = create_gemini_client(gemini_key)
        self.guild_id = guild_id
        self.oauth_server: tuple[web.AppRunner, web.TCPSite] | None = None
        self.talk_sessions: dict[int, TalkCodingSession] = {}
        self.voice_connect_locks: dict[int, asyncio.Lock] = {}
        self.talk_cleanup_task: asyncio.Task[None] | None = None

    async def setup_hook(self) -> None:
        patch_voice_recv_opus_decoder()
        init_database()
        self.oauth_server = await start_oauth_server()
        self.talk_cleanup_task = asyncio.create_task(self.cleanup_idle_talk_sessions())
        if self.guild_id:
            guild = discord.Object(id=self.guild_id)
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
        else:
            await self.tree.sync()

    async def close(self) -> None:
        if self.talk_cleanup_task:
            self.talk_cleanup_task.cancel()
        for session in list(self.talk_sessions.values()):
            if session.voice_client and hasattr(session.voice_client, "stop_listening"):
                session.voice_client.stop_listening()
            if session.voice_bridge:
                session.voice_bridge.stop()
            if session.voice_client and session.voice_client.is_connected():
                await session.voice_client.disconnect(force=True)
        if self.oauth_server:
            runner, _site = self.oauth_server
            await runner.cleanup()
        await super().close()

    async def cleanup_idle_talk_sessions(self) -> None:
        while not self.is_closed():
            await asyncio.sleep(TALK_SESSION_CLEANUP_INTERVAL_SECONDS)
            now = time.monotonic()
            for guild_id, session in list(self.talk_sessions.items()):
                if session.finalizing:
                    continue
                if now - session.last_active_at < TALK_SESSION_IDLE_SECONDS:
                    continue
                channel = self.get_channel(session.text_channel_id)
                if isinstance(channel, discord.abc.Messageable):
                    try:
                        await channel.send("トークコーディングが一定時間操作されなかったため、自動終了しました。")
                    except Exception:
                        pass
                await self.stop_talk_coding(guild_id)

    async def connect_talk_voice(
        self,
        voice_channel: discord.VoiceChannel | discord.StageChannel,
    ) -> discord.VoiceClient:
        existing = voice_channel.guild.voice_client
        if existing and existing.is_connected():
            await existing.disconnect(force=True)

        connect_kwargs = {
            "timeout": 20.0,
            "reconnect": False,
            "self_deaf": False,
            "self_mute": False,
        }
        if voice_recv is not None and talk_coding_voice_receive_enabled():
            try:
                return await voice_channel.connect(cls=voice_recv.VoiceRecvClient, **connect_kwargs)
            except Exception:
                existing = voice_channel.guild.voice_client
                if existing:
                    await existing.disconnect(force=True)

        return await voice_channel.connect(**connect_kwargs)

    async def connect_node_voice_bridge(
        self,
        guild_id: int,
        voice_channel_id: int,
        text_channel_id: int,
    ) -> NodeVoiceBridge:
        bridge = NodeVoiceBridge(self, guild_id, voice_channel_id, text_channel_id)
        await asyncio.to_thread(bridge.start)
        return bridge

    async def start_talk_coding(
        self,
        message: discord.Message,
        voice_channel: discord.VoiceChannel | discord.StageChannel,
    ) -> None:
        if not message.guild:
            return
        if voice_channel.guild.id != message.guild.id:
            await message.reply("別サーバーのVCには参加できません。")
            return
        lock = self.voice_connect_locks.setdefault(message.guild.id, asyncio.Lock())
        if lock.locked():
            await message.reply("VC接続処理中です。数秒待ってからもう一度試してください。")
            return

        async with lock:
            current = self.talk_sessions.get(message.guild.id)
            if current and session_voice_connected(current):
                if message.author.id != current.owner_id:
                    await message.reply("このサーバーでは別のトークコーディングが進行中です。開始した人が完成または終了してから使ってください。")
                    return
                if current.voice_channel_id != voice_channel.id and current.voice_client:
                    await current.voice_client.move_to(voice_channel)
                    current.voice_channel_id = voice_channel.id
                current.text_channel_id = message.channel.id
                self.start_voice_receive(current)
                await message.reply(f"Coderたんが {voice_channel.mention} に移動しました。")
                return

            try:
                if talk_coding_stt_mode() == TALK_STT_MODE_NODE_BRIDGE:
                    voice_bridge = await self.connect_node_voice_bridge(message.guild.id, voice_channel.id, message.channel.id)
                    voice_client = None
                else:
                    voice_bridge = None
                    voice_client = await self.connect_talk_voice(voice_channel)
            except Exception as exc:
                await message.reply(f"VC接続に失敗しました。再試行ループは停止しました: `{exc}`")
                return

            session = TalkCodingSession(
                guild_id=message.guild.id,
                session_id=secrets.token_urlsafe(12),
                owner_id=message.author.id,
                text_channel_id=message.channel.id,
                voice_channel_id=voice_channel.id,
                voice_client=voice_client,
                voice_bridge=voice_bridge,
                history=[f"{message.author.display_name}: {extract_talk_request(message)}"],
            )
            self.talk_sessions[message.guild.id] = session
            self.start_voice_receive(session)
            receive_note = "\nNode.js voice bridgeでVC音声認識を開始しました。" if session.voice_bridge else (
                "" if session.voice_client and hasattr(session.voice_client, "listen") else "\n音声認識用のVC受信接続に失敗したため、今回はテキスト反応のみで動作します。"
            )
            await message.reply(
                f"Coderたんが {voice_channel.mention} に参加しました。"
                " このチャンネルでメンションすると、Geminiでコード回答してTTS再生します。"
                f"{receive_note}"
            )

    async def stop_talk_coding(self, guild_id: int) -> None:
        session = self.talk_sessions.pop(guild_id, None)
        if session:
            if session.voice_client and hasattr(session.voice_client, "stop_listening"):
                session.voice_client.stop_listening()
            if session.voice_bridge:
                session.voice_bridge.stop()
            if session.voice_client and session.voice_client.is_connected():
                await session.voice_client.disconnect(force=True)

    def start_voice_receive(self, session: TalkCodingSession) -> None:
        if session.voice_bridge is not None:
            return
        if voice_recv is None or TalkCodingSpeechSink is None:
            return
        if not session.voice_client or not hasattr(session.voice_client, "listen"):
            return
        if getattr(session.voice_client, "is_listening", lambda: False)():
            return
        sink = TalkCodingSpeechSink(self, session.guild_id, asyncio.get_running_loop())
        listen_sink: Any = sink
        if hasattr(voice_recv, "SilenceGeneratorSink"):
            listen_sink = voice_recv.SilenceGeneratorSink(sink)
        session.speech_sink = listen_sink
        session.voice_client.listen(listen_sink)
        if talk_coding_debug_stt_enabled():
            asyncio.create_task(self.report_talk_debug(session.guild_id, "[STT] voice receive listener started"))

    async def report_talk_debug(self, guild_id: int, message: str) -> None:
        session = self.talk_sessions.get(guild_id)
        if not session:
            return
        channel = self.get_channel(session.text_channel_id)
        if isinstance(channel, discord.abc.Messageable):
            try:
                await channel.send(message[:1900])
            except Exception:
                pass

    async def handle_talk_coding_audio(
        self,
        guild_id: int,
        user: discord.Member | discord.User,
        pcm: bytes,
    ) -> None:
        session = self.talk_sessions.get(guild_id)
        if not session or session.finalizing:
            return
        member = resolve_session_member(self, session, user)
        if member is None or not user_is_in_session_voice(session, member):
            return
        if member.id in session.stt_inflight_users:
            return
        session.stt_inflight_users.add(member.id)
        try:
            mono_pcm = stereo_pcm_to_mono_linear16(pcm)
            rms = pcm_rms_linear16(mono_pcm)
            if talk_coding_debug_stt_enabled():
                duration = len(pcm) / (DISCORD_PCM_SAMPLE_RATE * DISCORD_PCM_CHANNELS * DISCORD_PCM_SAMPLE_WIDTH)
                await self.report_talk_debug(
                    guild_id,
                    f"[STT] sending {duration:.1f}s audio to Google (bytes={len(pcm)}, rms={rms})",
                )
            if rms < TALK_STT_MIN_RMS:
                if talk_coding_debug_stt_enabled():
                    await self.report_talk_debug(guild_id, "[STT] skipped quiet audio")
                return
            text = await transcribe_talk_audio(pcm)
        finally:
            session.stt_inflight_users.discard(member.id)
        if not text:
            if talk_coding_debug_stt_enabled():
                await self.report_talk_debug(guild_id, "[STT] Google returned no transcript")
            return
        if self.talk_sessions.get(guild_id) is not session or session.finalizing:
            return
        channel = self.get_channel(session.text_channel_id)
        if not isinstance(channel, discord.abc.Messageable):
            return

        user_text = text.strip()
        if talk_coding_debug_stt_enabled():
            await channel.send(f"[STT] {member.display_name}: {user_text[:180]}")
        wake_word = has_talk_wake_word(user_text)
        if wake_word:
            session.voice_armed_until = time.monotonic() + 15
            user_text = strip_talk_wake_word(user_text)
            if not user_text:
                await channel.send(f"{member.mention} 呼んだ？続けて話してね。")
                return
        elif time.monotonic() > session.voice_armed_until:
            return

        if member.id == session.owner_id and is_talk_complete_request(user_text):
            await self.finish_talk_coding(guild_id, requested_by=member)
            return

        await self.respond_to_talk_text(session, channel, member, user_text)

    async def handle_node_bridge_event(self, guild_id: int, payload: dict[str, Any]) -> None:
        session = self.talk_sessions.get(guild_id)
        if not session:
            return
        event_type = payload.get("type")
        channel = self.get_channel(session.text_channel_id)
        if event_type in {"ready", "debug", "error"}:
            if talk_coding_debug_stt_enabled() and isinstance(channel, discord.abc.Messageable):
                await channel.send(f"[voice-bridge] {payload.get('message', event_type)}")
            return
        if event_type != "transcript":
            return
        user_id = payload.get("user_id")
        text = payload.get("text")
        if not isinstance(user_id, str) or not isinstance(text, str) or not text.strip():
            return
        guild = self.get_guild(guild_id)
        member = guild.get_member(int(user_id)) if guild else None
        if member is None or not user_is_in_session_voice(session, member):
            return
        if not isinstance(channel, discord.abc.Messageable):
            return
        user_text = text.strip()
        if talk_coding_debug_stt_enabled():
            await channel.send(f"[STT] {member.display_name}: {user_text[:180]}")
        if has_talk_wake_word(user_text):
            session.voice_armed_until = time.monotonic() + 15
            user_text = strip_talk_wake_word(user_text)
            if not user_text:
                await channel.send(f"{member.mention} 呼んだ？続けて話してね。")
                return
        elif time.monotonic() > session.voice_armed_until:
            return
        if member.id == session.owner_id and is_talk_complete_request(user_text):
            await self.finish_talk_coding(guild_id, requested_by=member)
            return
        await self.respond_to_talk_text(session, channel, member, user_text)

    async def respond_to_talk_text(
        self,
        session: TalkCodingSession,
        channel: discord.abc.Messageable,
        author: discord.Member | discord.User,
        user_text: str,
    ) -> None:
        if self.talk_sessions.get(session.guild_id) is not session:
            return
        if session.finalizing:
            await channel.send("完成ファイルをまとめているところです。少し待ってください。")
            return
        if not session_channel_matches(session, channel):
            return
        if not user_is_in_session_voice(session, author):
            await channel.send("このトークコーディングのVCにいる人からの依頼だけ処理します。")
            return
        if session.response_lock.locked():
            await channel.send("いま前の依頼を処理中です。少し待ってからもう一度送ってください。")
            return
        async with session.response_lock:
            await self._respond_to_talk_text_locked(session, channel, author, user_text)

    async def _respond_to_talk_text_locked(
        self,
        session: TalkCodingSession,
        channel: discord.abc.Messageable,
        author: discord.Member | discord.User,
        user_text: str,
    ) -> None:
        if not session_voice_connected(session):
            self.talk_sessions.pop(session.guild_id, None)
            await channel.send("VC connection was closed, so talk coding ended.")
            return

        safe, reason = validate_talk_text(user_text)
        if not safe:
            await channel.send(reason or "この内容には音声返信できません。")
            return

        session.history.append(f"{author.display_name}: {user_text}")
        del session.history[:-60]
        session.last_active_at = time.monotonic()
        response = await generate_text_response(self.gemini, build_talk_coding_prompt(user_text), TALK_CODING_MODEL)
        session.history.append(f"Coder-tan: {response[:1200]}")
        del session.history[:-60]
        session.last_active_at = time.monotonic()

        chunks = split_discord_message(f"**Coder-tan**\n{response}")
        await channel.send(chunks[0])
        for chunk in chunks[1:]:
            await channel.send(chunk)

        try:
            played = await play_session_tts(session, response[:1200])
        except Exception as exc:
            await channel.send(f"TTS playback failed: `{exc}`")
            return
        if not played:
            await channel.send(
                "TTS is not configured. Set `TALK_CODING_TTS_API_KEY` and "
                "`TALK_CODING_TTS_API_URL` in `.env` to enable VC voice replies."
            )

    async def finish_talk_coding(
        self,
        guild_id: int,
        requested_by: discord.Member | discord.User,
    ) -> None:
        session = self.talk_sessions.get(guild_id)
        if not session or session.finalizing:
            return
        channel = self.get_channel(session.text_channel_id)
        if not isinstance(channel, discord.abc.Messageable):
            await self.stop_talk_coding(guild_id)
            return
        if requested_by.id != session.owner_id:
            await channel.send("トークコーディングを開始した人だけが完成できます。")
            return
        if not user_is_in_session_voice(session, requested_by):
            await channel.send("完成は、このトークコーディングのVCにいる開始者だけが実行できます。")
            return
        if session.response_lock.locked():
            await channel.send("いま前の依頼を処理中です。完了してからもう一度 `完成` を送ってください。")
            return

        session.finalizing = True
        await channel.send("完成したよ！こんな感じ？ファイルとプレビューを貼るね。修正したいところがあれば、もう一度メンションか「コーダーたん！」で言ってね。")
        try:
            await play_session_tts(session, "完成したよ。こんな感じ？ファイルとプレビューを貼るね。")
        except Exception:
            pass

        work_root = Path(tempfile.mkdtemp(prefix="discoder-talk-final-"))
        try:
            project = await generate_project(
                self.gemini,
                build_talk_final_prompt(session.history),
                "Auto-detected",
                TALK_CODING_MODEL,
                "Final output from a Discord VC talk-coding session.",
            )
            attachments = await build_project_attachments(project, work_root, session.history)
            source_summary = summarize_asset_sources(project)
            message = (
                f"**{project.title}**\n"
                f"{project.summary}\n\n"
                f"{source_summary}\n"
                f"`{len(project.files)}` files generated from talk coding. Model: `{TALK_CODING_MODEL}`"
            )
            drive_summary = await build_drive_save_summary(session.owner_id, attachments)
            await channel.send(content=(message + drive_summary)[:2000], files=make_discord_files(attachments))
        except Exception as exc:
            await channel.send(f"完成ファイルの生成に失敗しました: `{exc}`")
        finally:
            shutil.rmtree(work_root, ignore_errors=True)
            session.finalizing = False

    async def handle_talk_coding_message(self, message: discord.Message, user_text: str) -> None:
        if not message.guild:
            return
        session = self.talk_sessions.get(message.guild.id)
        if not session or session.text_channel_id != message.channel.id:
            return
        if message.author.id == session.owner_id and is_talk_complete_request(user_text):
            await self.finish_talk_coding(message.guild.id, requested_by=message.author)
            return
        async with message.channel.typing():
            await self.respond_to_talk_text(session, message.channel, message.author, user_text)
        return

    async def handle_talk_coding_voice_message(self, message: discord.Message) -> bool:
        if not message.guild or not message.attachments:
            return False
        if talk_coding_stt_mode() != TALK_STT_MODE_VOICE_MESSAGE:
            return False
        session = self.talk_sessions.get(message.guild.id)
        if not session or session.text_channel_id != message.channel.id:
            return False
        if not user_is_in_session_voice(session, message.author):
            return False

        attachment = next((item for item in message.attachments if is_audio_attachment(item)), None)
        if attachment is None:
            return False
        if attachment.size > 12 * 1024 * 1024:
            await message.reply("音声ファイルが大きすぎます。12MB以下で送ってください。")
            return True

        async with message.channel.typing():
            try:
                audio_data = await attachment.read()
                text = await transcribe_audio_file_data(audio_data)
            except Exception as exc:
                await message.reply(f"音声認識に失敗しました: `{exc}`")
                return True

            if not text:
                await message.reply("音声は受け取れましたが、認識できる発話がありませんでした。")
                return True

            if talk_coding_debug_stt_enabled():
                await message.channel.send(f"[STT] {message.author.display_name}: {text[:180]}")

            if has_talk_wake_word(text):
                text = strip_talk_wake_word(text)
            if message.author.id == session.owner_id and is_talk_complete_request(text):
                await self.finish_talk_coding(message.guild.id, requested_by=message.author)
                return True
            if not text:
                await message.reply("呼んだ？続けて話してね。")
                return True
            await self.respond_to_talk_text(session, message.channel, message.author, text)
            return True


discord_token, gemini_key, guild_id = load_settings()
bot = CoderBot(gemini_key=gemini_key, guild_id=guild_id)


@bot.event
async def on_ready() -> None:
    await bot.change_presence(activity=discord.Activity(type=discord.ActivityType.playing, name="Coderたん / Talk Coding"))
    print(f"Logged in as {bot.user} (ID: {bot.user.id if bot.user else 'unknown'})")


@bot.event
async def on_message(message: discord.Message) -> None:
    if message.author.bot or not message.guild or bot.user is None:
        return

    mentioned = bot.user in message.mentions
    content = extract_talk_request(message)
    wake_word = has_talk_wake_word(message.content)

    if mentioned:
        if is_talk_leave_request(content):
            session = bot.talk_sessions.get(message.guild.id)
            if session and message.author.id != session.owner_id:
                await message.reply("トークコーディングを開始した人だけが終了できます。")
                return
            await bot.stop_talk_coding(message.guild.id)
            await message.reply("トークコーディングを終了しました。")
            return

        voice_channel = find_requested_voice_channel(message)
        if voice_channel:
            await bot.start_talk_coding(message, voice_channel)
            remainder = content.strip()
            if remainder and not re.search(r"参加|入って|join|connect", remainder, re.IGNORECASE):
                await bot.handle_talk_coding_message(message, remainder)
            return

    if (mentioned or wake_word) and message.guild.id in bot.talk_sessions:
        user_text = content
        user_text = strip_talk_wake_word(user_text)
        if user_text:
            await bot.handle_talk_coding_message(message, user_text)
        else:
            await message.reply("聞きたい内容を続けて送ってください。")


@bot.tree.command(name="coder", description="Geminiでコードを生成してファイルで送信します。")
@app_commands.rename(content="内容", programming_language="プログラミング言語", model_name="モデル")
@app_commands.describe(
    content="作ってほしい内容",
    programming_language="プログラミング言語、フレームワーク、または技術スタックを選択",
    model_name="コード生成に使うGeminiモデル",
)
@app_commands.choices(programming_language=LANGUAGE_CHOICES, model_name=MODEL_CHOICES)
async def coder(
    interaction: discord.Interaction,
    content: str,
    programming_language: str,
    model_name: str = DEFAULT_MODEL,
) -> None:
    await interaction.response.defer(thinking=True, ephemeral=True)

    work_root = Path(tempfile.mkdtemp(prefix="discoder-"))
    try:
        selected_language = programming_language
        selected_model = model_name
        project_context = build_memory_context(interaction)
        project = await generate_project(
            bot.gemini,
            content,
            selected_language,
            selected_model,
            project_context,
        )
        project_dir = work_root / "project"
        project_dir.mkdir(parents=True, exist_ok=True)
        write_project(project, project_dir)

        zip_path = work_root / f"{safe_name(project.title)}.zip"
        make_zip(project_dir, zip_path)
        if zip_path.stat().st_size > MAX_DISCORD_FILE_SIZE:
            await interaction.followup.send(
                "生成結果がDiscordの添付上限を超えました。内容を小さくして再実行してください。",
                ephemeral=True,
            )
            return

        generated_attachments = [
            GeneratedAttachment(filename=zip_path.name, content=zip_path.read_bytes())
        ]
        preview = find_preview_file(project, project_dir)
        if preview:
            screenshot_path = work_root / "preview.png"
            try:
                if await screenshot_html(preview, screenshot_path):
                    generated_attachments.append(
                        GeneratedAttachment(filename="preview.png", content=screenshot_path.read_bytes())
                    )
            except Exception as exc:
                project.summary += f"\n\nプレビュー画像の作成に失敗しました: `{exc}`"

        file_count = len(project.files)
        source_summary = summarize_asset_sources(project)
        message = (
            f"**{project.title}**\n"
            f"{project.summary}\n\n"
            f"{source_summary}\n"
            f"詳細はzip内の `ASSET_SOURCES.md` を確認してください。\n\n"
            f"`{file_count}`個のファイルを生成しました。"
            f"言語/技術: `{selected_language}` / モデル: `{selected_model}`"
        )
        drive_summary = await build_drive_save_summary(interaction.user.id, generated_attachments)
        private_message = f"{message}{drive_summary}"
        view = PublishView(interaction.user.id, message[:2000], generated_attachments)
        await interaction.followup.send(
            content=private_message[:2000],
            files=make_discord_files(generated_attachments),
            view=view,
            ephemeral=True,
        )
        remember_project(
            interaction,
            "coder",
            f"Generated {project.title}. Request: {content}. Language: {selected_language}. Files: {file_count}.",
        )
    except GeminiBusyError as exc:
        await interaction.followup.send(f"生成に失敗しました: {exc}", ephemeral=True)
    except Exception as exc:
        await interaction.followup.send(f"生成に失敗しました: `{exc}`", ephemeral=True)
    finally:
        shutil.rmtree(work_root, ignore_errors=True)


@bot.tree.command(name="review", description="コードレビューを行います。")
@app_commands.rename(code="コード", programming_language="プログラミング言語", model_name="モデル", file="ファイル")
@app_commands.describe(
    code="レビューしたいコード。長い場合はファイル添付も使えます。",
    programming_language="プログラミング言語、フレームワーク、または技術スタックを選択",
    model_name="レビューに使うGeminiモデル",
    file="レビューしたいコードのテキストファイル",
)
@app_commands.choices(programming_language=LANGUAGE_CHOICES, model_name=MODEL_CHOICES)
async def review(
    interaction: discord.Interaction,
    code: str,
    programming_language: str,
    model_name: str = DEFAULT_MODEL,
    file: discord.Attachment | None = None,
) -> None:
    await interaction.response.defer(thinking=True, ephemeral=True)

    try:
        attached_code = await attachment_to_text(file)
        full_code = f"{code}\n\n{attached_code}".strip()
        project_context = build_memory_context(interaction)
        prompt = build_review_prompt(full_code, programming_language, project_context)
        response = await generate_text_response(bot.gemini, prompt, model_name)
        message = f"**Code Review**\n{response}\n\nモデル: `{model_name}`"
        await send_publishable_text(interaction, message, interaction.user.id)
        remember_project(
            interaction,
            "review",
            f"Reviewed {programming_language} code. Main response: {response[:500]}",
        )
    except GeminiBusyError as exc:
        await interaction.followup.send(f"レビューに失敗しました: {exc}", ephemeral=True)
    except Exception as exc:
        await interaction.followup.send(f"レビューに失敗しました: `{exc}`", ephemeral=True)


@bot.tree.command(name="debug", description="エラーやログから原因を解析します。")
@app_commands.rename(
    error_text="エラー",
    code="コード",
    programming_language="プログラミング言語",
    model_name="モデル",
    file="ファイル",
)
@app_commands.describe(
    error_text="貼り付けたいエラー、スタックトレース、ログ",
    code="関連コード。長い場合はファイル添付も使えます。",
    programming_language="プログラミング言語、フレームワーク、または技術スタックを選択",
    model_name="解析に使うGeminiモデル",
    file="関連コードやログのテキストファイル",
)
@app_commands.choices(programming_language=LANGUAGE_CHOICES, model_name=MODEL_CHOICES)
async def debug(
    interaction: discord.Interaction,
    error_text: str,
    programming_language: str,
    code: str | None = None,
    model_name: str = DEFAULT_MODEL,
    file: discord.Attachment | None = None,
) -> None:
    await interaction.response.defer(thinking=True, ephemeral=True)

    try:
        attached_text = await attachment_to_text(file)
        full_code = "\n\n".join(part for part in [code, attached_text] if part).strip() or None
        project_context = build_memory_context(interaction)
        prompt = build_debug_prompt(error_text, full_code, programming_language, project_context)
        response = await generate_text_response(bot.gemini, prompt, model_name)
        message = f"**Debug Analysis**\n{response}\n\nモデル: `{model_name}`"
        await send_publishable_text(interaction, message, interaction.user.id)
        remember_project(
            interaction,
            "debug",
            f"Debugged {programming_language} error: {error_text[:250]}. Main response: {response[:500]}",
        )
    except GeminiBusyError as exc:
        await interaction.followup.send(f"解析に失敗しました: {exc}", ephemeral=True)
    except Exception as exc:
        await interaction.followup.send(f"解析に失敗しました: `{exc}`", ephemeral=True)


generate_group = app_commands.Group(name="generate", description="機能単位でコードを生成します。")
drive_group = app_commands.Group(name="drive", description="Google Drive連携を管理します。")
talk_group = app_commands.Group(name="talk", description="トークコーディングを管理します。")


@generate_group.command(name="feature", description="既知のプロジェクト文脈に合わせて機能単位で生成します。")
@app_commands.rename(feature="機能", programming_language="プログラミング言語", model_name="モデル")
@app_commands.describe(
    feature="追加したい機能の内容",
    programming_language="プログラミング言語、フレームワーク、または技術スタックを選択",
    model_name="コード生成に使うGeminiモデル",
)
@app_commands.choices(programming_language=LANGUAGE_CHOICES, model_name=MODEL_CHOICES)
async def generate_feature(
    interaction: discord.Interaction,
    feature: str,
    programming_language: str,
    model_name: str = DEFAULT_MODEL,
) -> None:
    await interaction.response.defer(thinking=True, ephemeral=True)

    work_root = Path(tempfile.mkdtemp(prefix="discoder-feature-"))
    try:
        selected_language = programming_language
        selected_model = model_name
        project_context = build_memory_context(interaction)
        feature_request = (
            "Implement this as a focused feature addition for the known project. "
            "Reuse the project context when relevant and avoid unrelated rewrites.\n\n"
            f"{feature}"
        )
        project = await generate_project(
            bot.gemini,
            feature_request,
            selected_language,
            selected_model,
            project_context,
        )
        project_dir = work_root / "project"
        project_dir.mkdir(parents=True, exist_ok=True)
        write_project(project, project_dir)

        zip_path = work_root / f"{safe_name(project.title)}.zip"
        make_zip(project_dir, zip_path)
        if zip_path.stat().st_size > MAX_DISCORD_FILE_SIZE:
            await interaction.followup.send(
                "生成結果がDiscordの添付上限を超えました。内容を小さくして再実行してください。",
                ephemeral=True,
            )
            return

        generated_attachments = [
            GeneratedAttachment(filename=zip_path.name, content=zip_path.read_bytes())
        ]
        preview = find_preview_file(project, project_dir)
        if preview:
            screenshot_path = work_root / "preview.png"
            try:
                if await screenshot_html(preview, screenshot_path):
                    generated_attachments.append(
                        GeneratedAttachment(filename="preview.png", content=screenshot_path.read_bytes())
                    )
            except Exception as exc:
                project.summary += f"\n\nプレビュー画像の作成に失敗しました: `{exc}`"

        file_count = len(project.files)
        source_summary = summarize_asset_sources(project)
        message = (
            f"**{project.title}**\n"
            f"{project.summary}\n\n"
            f"{source_summary}\n"
            f"詳細はzip内の `ASSET_SOURCES.md` を確認してください。\n\n"
            f"`{file_count}`個のファイルを生成しました。"
            f"言語/技術: `{selected_language}` / モデル: `{selected_model}`"
        )
        drive_summary = await build_drive_save_summary(interaction.user.id, generated_attachments)
        private_message = f"{message}{drive_summary}"
        view = PublishView(interaction.user.id, message[:2000], generated_attachments)
        await interaction.followup.send(
            content=private_message[:2000],
            files=make_discord_files(generated_attachments),
            view=view,
            ephemeral=True,
        )
        remember_project(
            interaction,
            "generate feature",
            f"Generated feature {project.title}. Request: {feature}. Language: {selected_language}. Files: {file_count}.",
        )
    except GeminiBusyError as exc:
        await interaction.followup.send(f"生成に失敗しました: {exc}", ephemeral=True)
    except Exception as exc:
        await interaction.followup.send(f"生成に失敗しました: `{exc}`", ephemeral=True)
    finally:
        shutil.rmtree(work_root, ignore_errors=True)


bot.tree.add_command(generate_group)


@talk_group.command(name="leave", description="CoderたんをVCから退出させます。")
async def talk_leave(interaction: discord.Interaction) -> None:
    if interaction.guild_id is None:
        await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
        return

    session = bot.talk_sessions.get(interaction.guild_id)
    if session and interaction.user.id != session.owner_id:
        await interaction.response.send_message("トークコーディングを開始した人だけが退出できます。", ephemeral=True)
        return

    await bot.stop_talk_coding(interaction.guild_id)
    await interaction.response.send_message("CoderたんをVCから退出させました。", ephemeral=True)


bot.tree.add_command(talk_group)


@drive_group.command(name="connect", description="Google Drive連携の認証URLを発行します。")
async def drive_connect(interaction: discord.Interaction) -> None:
    await interaction.response.defer(ephemeral=True)

    if not google_oauth_configured():
        await interaction.followup.send(
            "Google Drive連携がBot側で未設定です。GOOGLE_CLIENT_ID と GOOGLE_CLIENT_SECRET を設定してください。",
            ephemeral=True,
        )
        return

    state = secrets.token_urlsafe(32)
    OAUTH_STATES[state] = interaction.user.id
    flow = create_google_flow(state)
    auth_url, _state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    localhost_note = ""
    if google_redirect_is_localhost():
        localhost_note = (
            "\n\n注意: 今のリダイレクトURIはlocalhostです。"
            "Botを動かしているPC以外のユーザーが認証するには、"
            "ngrok等の公開URLを `GOOGLE_PUBLIC_BASE_URL` または `GOOGLE_REDIRECT_URI` に設定してください。"
        )
    await interaction.followup.send(
        "以下のURLからGoogle Drive連携を許可してください。\n"
        f"{auth_url}\n\n"
        "連携後、このBotが生成したzipやpreview画像をあなたのGoogle Driveへ保存します。"
        f"{localhost_note}",
        ephemeral=True,
    )


@drive_group.command(name="status", description="Google Drive連携状態を確認します。")
async def drive_status(interaction: discord.Interaction) -> None:
    await interaction.response.defer(ephemeral=True)

    if not google_oauth_configured():
        await interaction.followup.send("Google Drive連携はBot側で未設定です。", ephemeral=True)
        return

    if is_google_connected(interaction.user.id):
        await interaction.followup.send(
            f"Google Drive連携済みです。保存先フォルダ名: `{google_drive_folder_name()}`",
            ephemeral=True,
        )
    else:
        await interaction.followup.send("未連携です。`/drive connect` で連携できます。", ephemeral=True)


@drive_group.command(name="disconnect", description="Google Drive連携を解除します。")
async def drive_disconnect(interaction: discord.Interaction) -> None:
    await interaction.response.defer(ephemeral=True)
    delete_google_credentials(interaction.user.id)
    await interaction.followup.send("Google Drive連携を解除しました。", ephemeral=True)


bot.tree.add_command(drive_group)


if __name__ == "__main__":
    bot.run(discord_token)
