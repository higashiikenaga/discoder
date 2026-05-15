require("dotenv").config();

// Puter.js uses WebSocket internally. Node 22's built-in undici WebSocket can
// recurse while closing failed Puter sockets, so prefer the mature ws package
// when it is available through Discord/voice dependencies.
try {
  globalThis.WebSocket = require("ws");
} catch {
}

const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
const http = require("http");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const { pathToFileURL } = require("url");
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  Partials,
  SlashCommandBuilder,
} = require("discord.js");
const {
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  entersState,
  generateDependencyReport,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
} = require("@discordjs/voice");
const { google } = require("googleapis");
const JSZip = require("jszip");
const prism = require("prism-media");
const { chromium } = require("playwright");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const PUTER_AUTH_TOKEN = process.env.PUTER_AUTH_TOKEN;
const PUTER_CHAT_MODEL = process.env.PUTER_CHAT_MODEL || "gemini-3-flash-preview";
const DEFAULT_CODE_MODEL = process.env.PUTER_CODE_MODEL || PUTER_CHAT_MODEL;
const PUTER_IMAGE_PROVIDER = process.env.PUTER_IMAGE_PROVIDER || "openai-image-generation";
const PUTER_IMAGE_MODEL = process.env.PUTER_IMAGE_MODEL || "gpt-image-1-mini";
const PUTER_IMAGE_QUALITY = process.env.PUTER_IMAGE_QUALITY || "low";
const PUTER_IMAGE_TEST_MODE = isTruthy(process.env.PUTER_IMAGE_TEST_MODE);
const PUTER_STT_MODEL = process.env.PUTER_STT_MODEL || "gpt-4o-mini-transcribe";
const PUTER_STT_MODELS = String(process.env.PUTER_STT_MODELS || PUTER_STT_MODEL)
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
const TALK_CODING_STT_PROVIDER = String(process.env.TALK_CODING_STT_PROVIDER || "local_whisper").toLowerCase();
const LOCAL_WHISPER_PYTHON = process.env.LOCAL_WHISPER_PYTHON || (process.platform === "win32" ? "python" : "python3");
const LOCAL_WHISPER_TIMEOUT_MS = Number(process.env.LOCAL_WHISPER_TIMEOUT_MS || 120000);
const LOCAL_WHISPER_PERSISTENT = !["0", "false", "no", "off"].includes(
  String(process.env.LOCAL_WHISPER_PERSISTENT || "true").toLowerCase()
);
const TALK_CODING_TTS_PROVIDER = String(process.env.TALK_CODING_TTS_PROVIDER || "qwen").toLowerCase();
const QWEN_TTS_PYTHON = process.env.QWEN_TTS_PYTHON || LOCAL_WHISPER_PYTHON;
const QWEN_TTS_TIMEOUT_MS = Number(process.env.QWEN_TTS_TIMEOUT_MS || 120000);
const TTS_MAX_CHARS = Number(process.env.TALK_CODING_TTS_MAX_CHARS || 220);
const PUTER_TTS_PROVIDER = process.env.PUTER_TTS_PROVIDER || "openai";
const PUTER_TTS_MODEL = process.env.PUTER_TTS_MODEL || "gpt-4o-mini-tts";
const PUTER_TTS_VOICE = process.env.PUTER_TTS_VOICE || "nova";
const PUTER_AI_TIMEOUT_MS = Number(process.env.PUTER_AI_TIMEOUT_MS || 90000);
const OPENROUTER_API_BASE = process.env.OPENROUTER_API_BASE || "https://openrouter.ai/api/v1";
const OPENROUTER_DEFAULT_MODEL = process.env.OPENROUTER_DEFAULT_MODEL || "openai/gpt-4o-mini";
const OPENROUTER_IMAGE_MODEL = process.env.OPENROUTER_IMAGE_MODEL || "openai/gpt-5-image-mini";
const OPENROUTER_VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || "openai/gpt-4o-mini";
const OPENROUTER_VIDEO_MODEL = process.env.OPENROUTER_VIDEO_MODEL || "bytedance/seedance-2.0-fast";
const OPENROUTER_VIDEO_SIZE = process.env.OPENROUTER_VIDEO_SIZE || "1280x720";
const OPENROUTER_USD_JPY = Number(process.env.OPENROUTER_USD_JPY || 155);
const STT_LANGUAGE = process.env.TALK_CODING_STT_LANGUAGE_CODE || "ja";
const DEBUG_STT = isTruthy(process.env.TALK_CODING_DEBUG_STT);
const SAVE_STT_AUDIO = isTruthy(process.env.TALK_CODING_SAVE_STT_AUDIO);
const STT_END_SILENCE_MS = Number(process.env.TALK_CODING_STT_END_SILENCE_MS || 3000);
const STT_MAX_RECORDING_MS = Number(process.env.TALK_CODING_STT_MAX_RECORDING_MS || 30000);
const STT_SCAN_SUBSCRIBE = isTruthy(process.env.TALK_CODING_STT_SCAN_SUBSCRIBE);
const VOICE_DECRYPTION_FAILURE_TOLERANCE = Number(process.env.DISCORD_VOICE_DECRYPTION_FAILURE_TOLERANCE || 250);
const VOICE_RECONNECT_INTERVAL_MS = Number(process.env.DISCORD_VOICE_RECONNECT_INTERVAL_MS || 5000);
const VOICE_RECONNECT_READY_TIMEOUT_MS = Number(process.env.DISCORD_VOICE_RECONNECT_READY_TIMEOUT_MS || 45000);
const VOICE_RECEIVE_USER_IDS = new Set(
  String(process.env.TALK_CODING_RECEIVE_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);
const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.file"];
const NODE_DRIVE_TOKEN_PATH = path.join(__dirname, "node_google_tokens.json");
const NODE_PUTER_TOKEN_PATH = path.join(__dirname, "node_puter_token.json");
const OAUTH_STATES = new Map();
const PUTER_AUTH_STATES = new Map();
let driveOAuthServerStarted = false;
const commandMemory = new Map();
const publishResults = new Map();
const pendingVideoRequests = new Map();
const MODEL_CHOICES = [
  "gemini-3-flash-preview",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gpt-5-nano",
  "openrouter/openai/gpt-4o-mini",
  "openrouter/google/gemini-2.5-flash",
  "openrouter/anthropic/claude-3.5-sonnet",
];
const MEDIA_PROVIDER_CHOICES = [
  { name: "auto", value: "auto" },
  { name: "puter", value: "puter" },
  { name: "openrouter", value: "openrouter" },
];
const OPENROUTER_IMAGE_MODEL_CHOICES = [
  "openai/gpt-5-image-mini",
  "google/gemini-2.5-flash-image",
  "black-forest-labs/flux-2-pro",
  "bytedance/seedream-4.5",
];
const OPENROUTER_VIDEO_MODEL_CHOICES = [
  "bytedance/seedance-2.0-fast",
  "alibaba/wan-2.6",
  "alibaba/wan-2.7",
  "google/veo-3.1",
];
const OPENROUTER_VISION_MODEL_CHOICES = [
  "openai/gpt-4o-mini",
  "google/gemini-2.5-flash",
  "anthropic/claude-3.5-sonnet",
];
const VIDEO_QUALITY_SIZES = {
  "480p": { width: 854, height: 480 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
};
const DEFAULT_VIDEO_QUALITY = "480p";
const DEFAULT_VIDEO_DURATION_SECONDS = 3;
const MAX_VIDEO_DURATION_SECONDS = 5;
const SUPPORT_MESSAGE = [
  "DisCoderをご利用いただき、ありがとうございます。",
  "DisCoderは実験中のAI Discord Botです。",
  "TTSや開発用のAPIなど、一部機能には開発者側のAI APIの利用料金も発生します。",
  "開発・運用費の支援はこちら：",
  "OFUSE: https://ofuse.me/a753ea67",
  "",
  "支援は任意です。ありがとうございます。",
].join("\n");
const SUPPORT_NOTICE = [
  "DisCoderは実験中のAI Discord Botです。",
  "TTSや開発用のAPIなど、一部機能には開発者側のAI APIの利用料金も発生します。",
  "開発・運用費の任意支援: https://ofuse.me/a753ea67",
].join("\n");
const HELP_MESSAGE = [
  "**DisCoder Help**",
  "",
  "**基本コマンド**",
  "`/coder` コードや小さなプロジェクトを生成します。",
  "`/review` コードレビューをします。ファイル添付も使えます。",
  "`/debug` エラーやログから原因を分析します。",
  "`/generate feature` 機能追加を生成します。",
  "`/video` 動画生成。実行前に高コスト警告と確認ボタンが出ます。",
  "",
  "**VCの使い方**",
  "`/talk join` VCに参加します。未指定なら自分がいるVCを使います。",
  "`/talk mode mode:雑談モード` 雑談寄りに切り替えます。",
  "`/talk mode mode:コーディングモード` 開発支援寄りに切り替えます。",
  "`/talk leave` VCから退出します。",
  "VC中は「コーダーたん！」と呼ぶか、Botにメンションして話しかけてください。",
  "",
  "**OpenRouter連携**",
  "`/openrouter connect api_key:<自分のAPIキー>` ユーザー個別のOpenRouterキーを保存します。",
  "`/openrouter media kind:video provider:openrouter model:bytedance/seedance-2.0-fast` 動画のフォールバック先を設定します。",
  "`/openrouter status` 設定を確認します。",
  "`/openrouter disconnect` 保存したAPIキーを削除します。",
  "Puter上限時は、設定済みならユーザー個別のOpenRouterへフォールバックします。",
  "",
  "**Puter / Drive / 支援**",
  "`/puter connect` 自分のPuterアカウントを連携します。",
  "`/drive connect` Google Drive保存を連携します。",
  "`/support` OFUSE支援案内を表示します。",
  "規約: `Terms.md` / プライバシー: `privacy-policy.md`",
  "",
  SUPPORT_NOTICE,
].join("\n");
const LANGUAGE_CHOICES = [
  "HTML/CSS/JavaScript",
  "Python",
  "Discord.py",
  "JavaScript",
  "TypeScript",
  "React",
  "Vue",
  "Next.js",
  "Tailwind CSS",
  "Node.js",
  "Java",
  "C#",
  "C++",
  "Go",
  "Rust",
  "PHP",
];
let opusReceiveAvailable = true;
const WAKE_PATTERNS = [
  /(?:オーダー|おーだー|オーダ|おーだ|おだー|order)\s*(?:たん|さん|ちゃん|tan)?/i,
  /(?:コー?ダー?|こー?だー?|こうだー?|こうだ|こだー?|こら|おら|おーら)\s*(?:たん|さん|ちゃん)?/i,
  /(?:coder|koder|corder)\s*(?:tan|さん|たん|ちゃん)?/i,
  /(?:コー|こー|こう)\s*(?:ダー|だー|だ)\s*(?:たん|さん|ちゃん)?/i,
  /コード\s*(?:たん|さん|ちゃん)?/i,
  /こーど\s*(?:たん|さん|ちゃん)?/i,
  /coder\s*(?:tan|たん|さん|ちゃん)?/i,
];

if (!DISCORD_TOKEN) throw new Error("DISCORD_TOKEN is not set.");
let puterPromise = null;
const userPuterPromises = new Map();
let localWhisperWorker = null;
const sessions = new Map();

function hasModule(name) {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

function checkVoiceReceiveRuntime() {
  console.log(generateDependencyReport());
  const encryptionOk = hasModule("libsodium-wrappers") || hasModule("sodium-native");
  const daveOk = hasModule("@snazzah/davey");
  const opusOk = hasModule("@discordjs/opus") || hasModule("node-opus") || hasModule("opusscript");
  if (!encryptionOk) {
    console.warn("[voice] No sodium encryption library is installed. VC receive may connect but return 0-byte audio.");
  }
  if (!daveOk) {
    console.warn("[voice] @snazzah/davey is not installed. DAVE encrypted voice channels cannot be received.");
  }
  if (!opusOk) {
    console.warn("[voice] No Opus decoder is installed. Install opusscript or @discordjs/opus.");
  }
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) {
    console.warn("[voice] @discordjs/voice latest requires Node 22.12.0 or newer for supported DAVE voice receive.");
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error?.stack || error);
});

process.on("unhandledRejection", (error) => {
  console.error("[unhandledRejection]", error?.stack || error);
});

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

async function getPuter(userId = null) {
  const userToken = userId ? loadPuterToken(userId) : null;
  if (userToken) {
    const cached = userPuterPromises.get(userId);
    if (cached?.token === userToken) return cached.promise;
    const promise = import("@heyputer/puter.js/src/init.cjs").then(({ init }) => init(userToken));
    userPuterPromises.set(userId, { token: userToken, promise });
    return promise;
  }
  if (!puterPromise) {
    puterPromise = import("@heyputer/puter.js/src/init.cjs").then(async ({ init, getAuthToken }) => {
      const authToken = await getPuterAuthToken(getAuthToken);
      return init(authToken);
    });
  }
  return puterPromise;
}

async function getPuterAuthToken(getAuthToken) {
  if (PUTER_AUTH_TOKEN) return PUTER_AUTH_TOKEN;
  const cached = loadPuterToken();
  if (cached) return cached;
  if (typeof getAuthToken !== "function") {
    throw new Error("Puter auth token is missing and this puter.js build does not provide getAuthToken().");
  }
  console.log("PUTER_AUTH_TOKEN is not set. Opening Puter browser login...");
  const token = await getAuthToken();
  if (!token) throw new Error("Puter browser login did not return an auth token.");
  savePuterToken(token);
  return token;
}

function loadPuterTokens() {
  try {
    return JSON.parse(fs.readFileSync(NODE_PUTER_TOKEN_PATH, "utf8"));
  } catch {
    return {};
  }
}

function loadPuterUserToken(userId) {
  return loadPuterTokens().users?.[userId] || null;
}

function loadPuterToken(userId = null) {
  if (userId) return loadPuterUserToken(userId);
  try {
    const data = JSON.parse(fs.readFileSync(NODE_PUTER_TOKEN_PATH, "utf8"));
    return data.authToken || null;
  } catch {
    return null;
  }
}

function savePuterToken(authToken) {
  const data = loadPuterTokens();
  data.authToken = authToken;
  fs.writeFileSync(NODE_PUTER_TOKEN_PATH, JSON.stringify(data, null, 2), "utf8");
}

function savePuterUserToken(userId, authToken) {
  const data = loadPuterTokens();
  data.users = data.users || {};
  data.users[userId] = authToken;
  fs.writeFileSync(NODE_PUTER_TOKEN_PATH, JSON.stringify(data, null, 2), "utf8");
  userPuterPromises.delete(userId);
}

function loadOpenRouterConfig(userId) {
  return loadPuterTokens().openrouter?.[userId] || null;
}

function saveOpenRouterConfig(userId, config) {
  const data = loadPuterTokens();
  data.openrouter = data.openrouter || {};
  data.openrouter[userId] = {
    apiKey: config.apiKey,
    model: config.model || OPENROUTER_DEFAULT_MODEL,
    imageModel: config.imageModel || OPENROUTER_IMAGE_MODEL,
    visionModel: config.visionModel || OPENROUTER_VISION_MODEL,
    videoModel: config.videoModel || OPENROUTER_VIDEO_MODEL,
    videoSize: normalizeVideoSize(config.videoSize || OPENROUTER_VIDEO_SIZE).size,
    imageProvider: config.imageProvider || "auto",
    visionProvider: config.visionProvider || "auto",
    videoProvider: config.videoProvider || "auto",
    fallbackEnabled: config.fallbackEnabled !== false,
  };
  fs.writeFileSync(NODE_PUTER_TOKEN_PATH, JSON.stringify(data, null, 2), "utf8");
}

function deleteOpenRouterConfig(userId) {
  const data = loadPuterTokens();
  if (data.openrouter) delete data.openrouter[userId];
  fs.writeFileSync(NODE_PUTER_TOKEN_PATH, JSON.stringify(data, null, 2), "utf8");
}

function hasOpenRouterConfig(userId) {
  return Boolean(loadOpenRouterConfig(userId)?.apiKey);
}

function openRouterMediaConfig(userId) {
  const config = loadOpenRouterConfig(userId) || {};
  return {
    ...config,
    imageModel: config.imageModel || OPENROUTER_IMAGE_MODEL,
    visionModel: config.visionModel || OPENROUTER_VISION_MODEL,
    videoModel: config.videoModel || OPENROUTER_VIDEO_MODEL,
    videoSize: normalizeVideoSize(config.videoSize || OPENROUTER_VIDEO_SIZE).size,
    imageProvider: config.imageProvider || "auto",
    visionProvider: config.visionProvider || "auto",
    videoProvider: config.videoProvider || "auto",
    fallbackEnabled: config.fallbackEnabled !== false,
  };
}

function shouldUseOpenRouterMedia(userId, kind) {
  const config = openRouterMediaConfig(userId);
  const provider = config[`${kind}Provider`] || "auto";
  if (provider === "openrouter") {
    if (!config.apiKey) throw new Error("OpenRouter未連携です。`/openrouter connect` で自分のAPIキーを登録してください。");
    return true;
  }
  return false;
}

function shouldFallbackToOpenRouterMedia(error, userId, kind) {
  const config = openRouterMediaConfig(userId);
  const provider = config[`${kind}Provider`] || "auto";
  return Boolean(config.apiKey && config.fallbackEnabled && provider !== "puter" && isPuterAiCreditLimitError(error));
}

function mediaRouteLabel(userId, kind, puterModel) {
  const config = openRouterMediaConfig(userId);
  const provider = config[`${kind}Provider`] || "auto";
  if (provider === "openrouter") return `OpenRouter ${config[`${kind}Model`]}`;
  if (provider === "auto") return `Puter ${puterModel} → OpenRouter ${config[`${kind}Model`]}`;
  return `Puter ${puterModel}`;
}

function normalizeVideoSize(value = OPENROUTER_VIDEO_SIZE) {
  const raw = String(value || OPENROUTER_VIDEO_SIZE).trim().toLowerCase().replace(/\s+/g, "");
  if (VIDEO_QUALITY_SIZES[raw]) {
    const size = videoQualityToSize(raw);
    return {
      size: size.size,
      width: size.width,
      height: size.height,
      resolution: openRouterResolutionForHeight(size.height),
      aspectRatio: aspectRatioForSize(size.width, size.height),
    };
  }
  const aliases = {
    low: OPENROUTER_VIDEO_SIZE,
    hd: "1280x720",
    "720p": "1280x720",
    fullhd: "1920x1080",
    fhd: "1920x1080",
    "1080p": "1920x1080",
    portrait720: "720x1280",
    vertical720: "720x1280",
    portrait1080: "1080x1920",
    vertical1080: "1080x1920",
  };
  const normalized = aliases[raw] || raw;
  const match = normalized.match(/^(\d{3,4})x(\d{3,4})$/);
  if (!match) return value === "1280x720" ? { size: "1280x720", width: 1280, height: 720, resolution: "720p", aspectRatio: "16:9" } : normalizeVideoSize("1280x720");
  const width = Number(match[1]);
  const height = Number(match[2]);
  const resolution = openRouterResolutionForHeight(Math.min(width, height));
  const aspectRatio = aspectRatioForSize(width, height);
  return { size: `${width}x${height}`, width, height, resolution, aspectRatio };
}

function openRouterResolutionForHeight(height) {
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  return "480p";
}

function aspectRatioForSize(width, height) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const divisor = gcd(width, height);
  const ratio = `${width / divisor}:${height / divisor}`;
  const common = new Set(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21"]);
  return common.has(ratio) ? ratio : width >= height ? "16:9" : "9:16";
}

function extractVideoSize(text, fallback = OPENROUTER_VIDEO_SIZE) {
  const match = String(text || "").match(/\b(\d{3,4})\s*[x×]\s*(\d{3,4})\b/i);
  return normalizeVideoSize(match ? `${match[1]}x${match[2]}` : fallback);
}

function videoQualityToSize(quality = DEFAULT_VIDEO_QUALITY) {
  const normalized = String(quality || DEFAULT_VIDEO_QUALITY).toLowerCase();
  const size = VIDEO_QUALITY_SIZES[normalized];
  if (!size) throw new Error(`不正なqualityです: ${quality}`);
  return { quality: normalized, ...size, size: `${size.width}x${size.height}` };
}

function normalizeVideoDurationSeconds(value = DEFAULT_VIDEO_DURATION_SECONDS) {
  const duration = Number(value || DEFAULT_VIDEO_DURATION_SECONDS);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("durationは1秒以上で指定してください。");
  if (duration > MAX_VIDEO_DURATION_SECONDS) throw new Error(`durationは最大${MAX_VIDEO_DURATION_SECONDS}秒までです。`);
  return Math.ceil(duration);
}

function cleanupPendingVideoRequests() {
  const now = Date.now();
  for (const [id, request] of pendingVideoRequests) {
    if (request.expiresAt <= now) pendingVideoRequests.delete(id);
  }
}

function deletePuterUserToken(userId) {
  const data = loadPuterTokens();
  if (data.users) delete data.users[userId];
  fs.writeFileSync(NODE_PUTER_TOKEN_PATH, JSON.stringify(data, null, 2), "utf8");
  userPuterPromises.delete(userId);
}

function hasPuterUserToken(userId) {
  return Boolean(loadPuterUserToken(userId));
}

function extractText(response) {
  if (response == null) return "";
  if (typeof response === "string") return response;
  if (typeof response === "number" || typeof response === "boolean") return String(response);
  if (Buffer.isBuffer(response)) return response.toString("utf8");
  if (Array.isArray(response)) return response.map(extractText).filter(Boolean).join("\n");
  if (typeof response !== "object") return String(response);

  const candidates = [
    response.text,
    response.transcript,
    response.transcription,
    response.output_text,
    response.output,
    response.result,
    response.data,
    response.value,
    response.message?.content,
    response.content,
    response.choices?.[0]?.message?.content,
    response.choices?.[0]?.text,
    response.alternatives?.[0]?.transcript,
  ];
  for (const candidate of candidates) {
    if (candidate == null || candidate === response) continue;
    const text = extractText(candidate).trim();
    if (text) return text;
  }

  const stringified = String(response);
  return stringified === "[object Object]" ? "" : stringified;
}

function safeName(value) {
  return String(value || "generated-code").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "generated-code";
}

function extractJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI response did not contain JSON.");
    return JSON.parse(match[0]);
  }
}

const BRAIN_AGENT_PROMPT = `
Internal brain meeting:
- Coder-tan: implementation, file generation, bug fixes, and library choices.
- Designer-tan: UI/UX, color palettes, animation, and aesthetic polish.
- Review-tan: lint, security, readability, async risks, and diff review.
- Tester-tan: test cases, execution paths, reproduction steps, and responsive breakage.

Run these four perspectives internally before finalizing. Resolve conflicts by improving the files.
Expose only a short public summary in "brain_meeting"; do not include hidden chain-of-thought.
`.trim();

function normalizeBrainMeeting(items) {
  const fallback = [
    { agent: "コーダーたん", comment: "実装方針を整理して成果物に反映しました！" },
    { agent: "レビューたん", comment: "安全性と可読性の観点で確認しました。" },
  ];
  const source = Array.isArray(items) && items.length ? items : fallback;
  return source
    .slice(0, 4)
    .map((item) => {
      if (typeof item === "string") return { agent: "レビューたん", comment: item.slice(0, 180) };
      return {
        agent: String(item.agent || item.role || "レビューたん").slice(0, 24),
        comment: String(item.comment || item.message || item.content || "").slice(0, 180),
      };
    })
    .filter((item) => item.comment);
}

function validateProject(data) {
  if (!Array.isArray(data.files) || data.files.length === 0) throw new Error("Project JSON did not include files.");
  const files = data.files.map((file) => {
    const filePath = String(file.path || "").replace(/\\/g, "/");
    if (!filePath || path.isAbsolute(filePath) || filePath.split("/").includes("..")) throw new Error(`Unsafe file path: ${filePath}`);
    return { path: filePath, content: String(file.content ?? "") };
  });
  return {
    title: String(data.title || "generated-code"),
    summary: String(data.summary || "生成しました。"),
    preview_file: typeof data.preview_file === "string" ? data.preview_file.replace(/\\/g, "/") : null,
    asset_sources: Array.isArray(data.asset_sources) ? data.asset_sources : [],
    brain_meeting: normalizeBrainMeeting(data.brain_meeting),
    files,
  };
}

function buildProjectPrompt(request, history) {
  return `
You are Coder-tan coordinating a multi-agent brain meeting to generate a complete runnable coding result.

${BRAIN_AGENT_PROMPT}

Talk coding transcript:
${history.map((item) => `${item.role}: ${item.content}`).join("\n").slice(-8000)}

User request:
${request}

Return only valid JSON with this schema:
{
  "title": "short project title",
  "summary": "short Japanese summary",
  "preview_file": "relative path to an HTML file to screenshot, or null",
  "asset_sources": [{"asset": "name", "source": "url or none", "license": "note"}],
  "brain_meeting": [{"agent": "コーダーたん", "comment": "short public Japanese comment"}],
  "files": [{"path": "relative/file/path.ext", "content": "full file content"}]
}

Rules:
- Generate complete files, not fragments.
- Keep paths relative. Do not use absolute paths or .. segments.
- If a web UI is generated, include a directly previewable HTML file.
- Include README.md when setup or run steps are useful.
- Use the four-agent meeting to check implementation, UI/UX, review risks, and tests before writing the final JSON.
`.trim();
}

async function generateProject(session, request, userId = session.ownerId) {
  const response = await puterChat(buildProjectPrompt(request, session.history), PUTER_CHAT_MODEL, "talk final project", userId);
  const project = validateProject(extractJson(extractText(response)));
  project.ai_meta = aiUsageMeta(response);
  return project;
}

function buildCommandProjectPrompt(request, programmingLanguage, projectContext) {
  return `
You are Coder-tan coordinating a multi-agent brain meeting to generate a complete runnable coding result.

${BRAIN_AGENT_PROMPT}

Known project context:
${projectContext || "No prior context."}

Language/framework:
${programmingLanguage}

User request:
${request}

Return only valid JSON with this schema:
{
  "title": "short project title",
  "summary": "short Japanese summary",
  "preview_file": "relative path to an HTML file to screenshot, or null",
  "asset_sources": [{"asset": "name", "source": "url or none", "license": "note"}],
  "brain_meeting": [{"agent": "コーダーたん", "comment": "short public Japanese comment"}],
  "files": [{"path": "relative/file/path.ext", "content": "full file content"}]
}

Rules:
- Generate complete files, not fragments.
- Keep paths relative. Do not use absolute paths or .. segments.
- If a web UI is generated, include a directly previewable HTML file.
- Include README.md when setup or run steps are useful.
- Prefer a focused answer that matches the requested language/framework.
- Use the four-agent meeting to check implementation, UI/UX, review risks, and tests before writing the final JSON.
`.trim();
}

async function generateProjectForCommand(request, programmingLanguage, model, projectContext, userId = null) {
  const selectedModel = model || DEFAULT_CODE_MODEL;
  const response = await puterChat(buildCommandProjectPrompt(request, programmingLanguage, projectContext), selectedModel, "project generation", userId);
  const project = validateProject(extractJson(extractText(response)));
  project.ai_meta = aiUsageMeta(response);
  return project;
}

async function generateTextResponse(prompt, model, userId = null) {
  const selectedModel = model || DEFAULT_CODE_MODEL;
  const response = await puterChat(prompt, selectedModel, "text response", userId);
  const usageLine = aiUsageLine(response);
  return `${extractText(response).trim() || "回答を生成できませんでした。"}${usageLine ? `\n\n${usageLine}` : ""}`;
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!match) return null;
  const mimeType = match[1] || "application/octet-stream";
  const body = match[3] || "";
  const buffer = match[2] ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8");
  return { buffer, mimeType };
}

async function imageSourceToAttachment(source, name = "generated-image.png") {
  if (isInsufficientFundsResult(source)) {
    const error = new Error(puterAiCreditLimitMessage());
    error.code = "insufficient_funds";
    throw error;
  }
  const data = dataUrlToBuffer(source);
  if (data) {
    const ext = data.mimeType.includes("jpeg") ? "jpg" : data.mimeType.includes("webp") ? "webp" : "png";
    return new AttachmentBuilder(data.buffer, { name: name.replace(/\.png$/i, `.${ext}`) });
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(String(source || "")) && String(source || "").length > 1000) {
    return new AttachmentBuilder(Buffer.from(String(source), "base64"), { name });
  }
  if (/^https?:\/\//i.test(String(source || ""))) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`image fetch failed: ${response.status}`);
    const contentType = response.headers.get("content-type") || "image/png";
    const ext = contentType.includes("jpeg") ? "jpg" : contentType.includes("webp") ? "webp" : "png";
    return new AttachmentBuilder(Buffer.from(await response.arrayBuffer()), { name: name.replace(/\.png$/i, `.${ext}`) });
  }
  throw new Error("image generation returned unsupported source");
}

async function generateImageAttachment(prompt, userId = null) {
  if (shouldUseOpenRouterMedia(userId, "image")) return generateOpenRouterImageAttachment(prompt, userId);
  try {
    const puter = await getPuter(userId);
    const options = {
      provider: PUTER_IMAGE_PROVIDER,
      model: PUTER_IMAGE_MODEL,
      quality: PUTER_IMAGE_QUALITY,
      test_mode: PUTER_IMAGE_TEST_MODE,
    };
    const image = await withTimeout(
      puter.ai.txt2img(prompt, options),
      `puter.ai.txt2img ${PUTER_IMAGE_MODEL}`,
      PUTER_AI_TIMEOUT_MS
    );
    return await imageSourceToAttachment(image?.src || String(image), `${safeName(prompt || "generated-image")}.png`);
  } catch (error) {
    if (shouldFallbackToOpenRouterMedia(error, userId, "image")) return generateOpenRouterImageAttachment(prompt, userId, true);
    throw error;
  }
}

function puterVideoModelForDate(now = new Date()) {
  const soraEndExclusiveJst = new Date("2026-09-24T00:00:00+09:00");
  return now.getTime() < soraEndExclusiveJst.getTime() ? "sora-2" : "veo-3.1-lite-generate-preview";
}

function isSora2Available(now = new Date()) {
  return puterVideoModelForDate(now) === "sora-2";
}

function sora2MigrationNotice(now = new Date()) {
  if (!isSora2Available(now)) return "当botでのOpenAI Sora2の提供は終了しました。今後はGoogle Veoに移行します。";
  return "9月24日でSora2のAPI提供が終了するため、今後はGoogle Veoに移行します。";
}

async function mediaSourceToAttachment(source, name, fallbackMimeType = "application/octet-stream") {
  const data = dataUrlToBuffer(source);
  if (data) {
    const ext = extensionForMimeType(data.mimeType, path.extname(name).slice(1) || "bin");
    return new AttachmentBuilder(data.buffer, { name: replaceExtension(name, ext) });
  }
  if (/^https?:\/\//i.test(String(source || ""))) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`media fetch failed: ${response.status}`);
    const contentType = response.headers.get("content-type") || fallbackMimeType;
    const ext = extensionForMimeType(contentType, path.extname(name).slice(1) || "bin");
    return new AttachmentBuilder(Buffer.from(await response.arrayBuffer()), { name: replaceExtension(name, ext) });
  }
  throw new Error("generation returned unsupported media source");
}

function collectMediaSources(value, seen = new Set()) {
  if (value == null) return [];
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);

  const sources = [];
  for (const key of ["src", "url", "href", "asset_url", "source", "data", "download_url", "video_url", "image_url", "b64_json", "output", "result", "choices", "message", "images", "content"]) {
    if (value[key] != null) sources.push(...collectMediaSources(value[key], seen));
  }
  if (typeof value.getAttribute === "function") {
    for (const attr of ["data-source", "src", "href"]) {
      const attrValue = value.getAttribute(attr);
      if (attrValue) sources.push(attrValue);
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) sources.push(...collectMediaSources(item, seen));
  }
  return sources;
}

async function mediaResultToAttachment(value, name, fallbackMimeType) {
  if (isInsufficientFundsResult(value)) {
    const error = new Error(puterAiCreditLimitMessage());
    error.code = "insufficient_funds";
    throw error;
  }
  const sources = collectMediaSources(value);
  let lastError = null;
  for (const source of sources) {
    try {
      return await mediaSourceToAttachment(source, name, fallbackMimeType);
    } catch (error) {
      lastError = error;
    }
  }
  const error = new Error(`generation returned unsupported media source: ${summarizeValue(value).slice(0, 500)}`);
  if (lastError) error.cause = lastError;
  throw error;
}

function isInsufficientFundsResult(value) {
  if (value == null) return false;
  if (typeof value === "string") return /insufficient[_\s-]?funds/i.test(value);
  if (typeof value !== "object") return false;
  const fields = [value.error, value.message, value.code, value.status, value.reason].map((item) => String(item || ""));
  if (fields.some((field) => /insufficient[_\s-]?funds/i.test(field))) return true;
  return [value.output, value.result, value.data].some(isInsufficientFundsResult);
}

const PUTER_AI_CREDIT_LIMIT_MESSAGE =
  "PuterのAI利用枠に達した可能性があります。現在、追加AIクレジットの購入方法はPuter公式ドキュメントで明確に案内されていません。Puterアカウント画面、またはPuter公式サポートをご確認ください。";

function puterAiCreditLimitMessage() {
  return "PuterのAI利用枠に達した可能性があります。現在、追加AIクレジットの購入方法はPuter公式ドキュメントで明確に案内されていません。続行するには `/openrouter connect` で自分のOpenRouter APIキーを連携してください。Puter側はPuterアカウント画面、またはPuter公式サポートをご確認ください。";
}

function isPuterAiCreditLimitError(error) {
  const text = [
    error?.message,
    error?.code,
    error?.status,
    error?.error,
    error?.response?.status,
    error?.response?.statusText,
    summarizeValue(error).slice(0, 1000),
  ]
    .filter(Boolean)
    .join(" ");
  return /insufficient[_\s-]?funds|credit|quota|limit|payment|required|402|429/i.test(text);
}

function replaceExtension(name, ext) {
  return String(name || "generated-media.bin").replace(/\.[A-Za-z0-9]+$/i, `.${ext}`);
}

function extensionForMimeType(mimeType, fallback = "bin") {
  const type = String(mimeType || "").toLowerCase();
  if (type.includes("jpeg")) return "jpg";
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  if (type.includes("mp4")) return "mp4";
  if (type.includes("webm")) return "webm";
  if (type.includes("quicktime")) return "mov";
  return fallback;
}

async function generateVideoAttachment(prompt, preferredModel = puterVideoModelForDate(), userId = null, requestedSize = null, requestedDuration = DEFAULT_VIDEO_DURATION_SECONDS) {
  if (shouldUseOpenRouterMedia(userId, "video")) return generateOpenRouterVideoAttachment(prompt, userId, false, requestedSize, requestedDuration);
  const model = preferredModel;
  try {
    const puter = await getPuter(userId);
    const options = { model };
    console.log(`[txt2vid] start model=${model} prompt=${prompt.slice(0, 200)}`);
    const video = await withTimeout(puter.ai.txt2vid(prompt, options), `puter.ai.txt2vid ${model}`, 10 * 60 * 1000);
    console.log(`[txt2vid] response model=${model} raw=${summarizeValue(video).slice(0, 500)}`);
    if (isInsufficientFundsResult(video)) {
      const error = new Error(puterAiCreditLimitMessage());
      error.code = "insufficient_funds";
      throw error;
    }
    return {
      attachment: await mediaResultToAttachment(video, `${safeName(prompt || "generated-video")}.mp4`, "video/mp4"),
      model,
    };
  } catch (error) {
    if (shouldFallbackToOpenRouterMedia(error, userId, "video")) return generateOpenRouterVideoAttachment(prompt, userId, true, requestedSize, requestedDuration);
    throw error;
  }
}

async function extractTextFromImageSource(source, userId = null) {
  if (shouldUseOpenRouterMedia(userId, "vision")) return extractTextFromImageSourceWithOpenRouter(source, userId);
  const puter = await getPuter(userId);
  try {
    const response = await withTimeout(
      puter.ai.img2txt(source, { provider: "aws-textract" }),
      "puter.ai.img2txt aws-textract",
      PUTER_AI_TIMEOUT_MS
    );
    return extractText(response).trim();
  } catch (error) {
    if (shouldFallbackToOpenRouterMedia(error, userId, "vision")) return extractTextFromImageSourceWithOpenRouter(source, userId, true);
    throw error;
  }
}

async function updateInteractionProgress(interaction, message) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message);
    }
  } catch (error) {
    console.error("progress update failed:", error.message);
  }
}

function logCommandError(commandName, error) {
  console.error(`[${commandName}] failed:`, error?.stack || error);
}

async function withTimeout(promise, label, timeoutMs = PUTER_AI_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function openRouterModelName(model, userId = null) {
  if (String(model || "").startsWith("openrouter/")) return String(model).slice("openrouter/".length);
  return loadOpenRouterConfig(userId)?.model || OPENROUTER_DEFAULT_MODEL;
}

function shouldUseOpenRouter(model) {
  return String(model || "").startsWith("openrouter/");
}

async function openRouterChat(prompt, model, label, userId) {
  const config = loadOpenRouterConfig(userId);
  if (!config?.apiKey) throw new Error("OpenRouter未連携です。`/openrouter connect` で自分のAPIキーを登録してください。");
  const openRouterModel = openRouterModelName(model, userId);
  const startedAt = Date.now();
  console.log(`[AI] ${label} start provider=openrouter model=${openRouterModel}`);
  const response = await withTimeout(
    fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/higashiikenaga/discoder",
        "X-Title": "DisCoder",
      },
      body: JSON.stringify({
        model: openRouterModel,
        messages: Array.isArray(prompt) ? prompt : [{ role: "user", content: String(prompt) }],
      }),
    }),
    `openrouter.chat ${openRouterModel}`
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`OpenRouter ${response.status}: ${extractText(data) || summarizeValue(data).slice(0, 300)}`);
  }
  data.__discoder_ai = {
    provider: "OpenRouter",
    model: openRouterModel,
    fallback: !shouldUseOpenRouter(model),
  };
  await attachOpenRouterCost(data, config.apiKey).catch((error) => console.warn("[OpenRouter] cost lookup failed:", error.message));
  console.log(`[AI] ${label} done provider=openrouter model=${openRouterModel} ${Date.now() - startedAt}ms`);
  return data;
}

async function attachOpenRouterCost(response, apiKey) {
  if (!response?.id) return;
  const stats = await withTimeout(
    fetch(`${OPENROUTER_API_BASE}/generation?id=${encodeURIComponent(response.id)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
    "openrouter.generation",
    15000
  );
  if (!stats.ok) return;
  const data = await stats.json();
  const costUsd = Number(data?.data?.total_cost ?? data?.data?.usage ?? data?.total_cost);
  if (!Number.isFinite(costUsd)) return;
  response.__discoder_ai.costUsd = costUsd;
  response.__discoder_ai.costJpy = costUsd * OPENROUTER_USD_JPY;
}

async function generateOpenRouterImageAttachment(prompt, userId, fallback = false) {
  const config = openRouterMediaConfig(userId);
  if (!config.apiKey) throw new Error("OpenRouter未連携です。`/openrouter connect` で自分のAPIキーを登録してください。");
  const model = config.imageModel;
  const response = await withTimeout(
    fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/higashiikenaga/discoder",
        "X-Title": "DisCoder",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: String(prompt) }],
        modalities: ["image", "text"],
        stream: false,
      }),
    }),
    `openrouter.image ${model}`,
    180000
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`OpenRouter image ${response.status}: ${extractText(data) || summarizeValue(data).slice(0, 300)}`);
  data.__discoder_ai = { provider: "OpenRouter", model, fallback };
  await attachOpenRouterCost(data, config.apiKey).catch((error) => console.warn("[OpenRouter] image cost lookup failed:", error.message));
  let attachment = null;
  for (const source of collectMediaSources(data)) {
    try {
      attachment = await imageSourceToAttachment(source, `${safeName(prompt || "generated-image")}.png`);
      break;
    } catch {
    }
  }
  if (!attachment) throw new Error(`OpenRouter image returned no usable image source: ${summarizeValue(data).slice(0, 500)}`);
  attachment.__discoder_ai = data.__discoder_ai;
  return attachment;
}

async function extractTextFromImageSourceWithOpenRouter(source, userId, fallback = false) {
  const config = openRouterMediaConfig(userId);
  if (!config.apiKey) throw new Error("OpenRouter未連携です。`/openrouter connect` で自分のAPIキーを登録してください。");
  const model = config.visionModel;
  const response = await openRouterChat(
    [
      {
        role: "user",
        content: [
          { type: "text", text: "この画像を日本語で読み取り、文字があればOCR結果も含めて簡潔に説明してください。" },
          { type: "image_url", image_url: { url: source } },
        ],
      },
    ],
    `openrouter/${model}`,
    "openrouter vision",
    userId
  );
  if (response.__discoder_ai) response.__discoder_ai.fallback = fallback;
  const usageLine = aiUsageLine(response);
  return `${extractText(response).trim()}${usageLine ? `\n\n${usageLine}` : ""}`.trim();
}

async function generateOpenRouterVideoAttachment(prompt, userId, fallback = false, requestedSize = null, requestedDuration = DEFAULT_VIDEO_DURATION_SECONDS) {
  const config = openRouterMediaConfig(userId);
  if (!config.apiKey) throw new Error("OpenRouter未連携です。`/openrouter connect` で自分のAPIキーを登録してください。");
  const model = config.videoModel;
  const videoSize = normalizeVideoSize(requestedSize || config.videoSize);
  const duration = normalizeVideoDurationSeconds(requestedDuration);
  const createResponse = await withTimeout(
    fetch(`${OPENROUTER_API_BASE}/videos`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/higashiikenaga/discoder",
        "X-Title": "DisCoder",
      },
      body: JSON.stringify({
        model,
        prompt: String(prompt),
        duration,
        resolution: videoSize.resolution,
        aspect_ratio: videoSize.aspectRatio,
      }),
    }),
    `openrouter.video.create ${model}`,
    30000
  );
  const created = await createResponse.json().catch(() => ({}));
  if (!createResponse.ok) throw new Error(`OpenRouter video ${createResponse.status}: ${extractText(created) || summarizeValue(created).slice(0, 300)}`);
  const jobId = created.id || created.data?.id || created.job_id || created.data?.job_id;
  if (!jobId) throw new Error(`OpenRouter video did not return a job id: ${summarizeValue(created).slice(0, 300)}`);
  const job = await pollOpenRouterVideoJob(jobId, config.apiKey);
  const contentUrl = `${OPENROUTER_API_BASE}/videos/${encodeURIComponent(jobId)}/content`;
  const contentResponse = await withTimeout(
    fetch(contentUrl, { headers: { Authorization: `Bearer ${config.apiKey}` } }),
    `openrouter.video.content ${model}`,
    60000
  );
  if (!contentResponse.ok) throw new Error(`OpenRouter video content ${contentResponse.status}`);
  const contentType = contentResponse.headers.get("content-type") || "video/mp4";
  const attachment = new AttachmentBuilder(Buffer.from(await contentResponse.arrayBuffer()), {
    name: replaceExtension(`${safeName(prompt || "generated-video")}.mp4`, extensionForMimeType(contentType, "mp4")),
  });
  return {
    attachment,
    model,
    provider: "OpenRouter",
    size: videoSize.size,
    duration,
    fallbackFrom: fallback ? "puter" : null,
    ai_meta: openRouterVideoUsageMeta(job, model, fallback, videoSize.size, duration),
  };
}

async function pollOpenRouterVideoJob(jobId, apiKey) {
  const deadline = Date.now() + 10 * 60 * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${OPENROUTER_API_BASE}/videos/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    last = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`OpenRouter video poll ${response.status}: ${summarizeValue(last).slice(0, 300)}`);
    const status = String(last.status || last.data?.status || "").toLowerCase();
    if (["completed", "succeeded", "success", "done"].includes(status)) return last;
    if (["failed", "error", "cancelled", "canceled"].includes(status)) throw new Error(`OpenRouter video failed: ${summarizeValue(last).slice(0, 400)}`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`OpenRouter video timed out: ${summarizeValue(last).slice(0, 300)}`);
}

function openRouterVideoUsageMeta(job, model, fallback, size = null, duration = null) {
  const costUsd = Number(job?.data?.total_cost ?? job?.total_cost ?? job?.data?.cost ?? job?.cost);
  return {
    provider: "OpenRouter",
    model,
    fallback,
    size,
    duration,
    costUsd: Number.isFinite(costUsd) ? costUsd : undefined,
    costJpy: Number.isFinite(costUsd) ? costUsd * OPENROUTER_USD_JPY : undefined,
  };
}

function videoSizeLabel(result) {
  return result?.size ? `\nSize: \`${result.size}\`` : "";
}

function aiUsageMeta(response) {
  return response?.__discoder_ai || null;
}

function aiUsageLine(responseOrProject) {
  const meta = responseOrProject?.ai_meta || aiUsageMeta(responseOrProject);
  if (!meta) return "";
  const fallback = meta.fallback ? " / Puter上限からフォールバック" : "";
  const size = meta.size ? ` / ${meta.size}` : "";
  const duration = meta.duration ? ` / ${meta.duration}s` : "";
  const cost = Number.isFinite(meta.costJpy)
    ? ` / 概算 ${meta.costJpy.toFixed(meta.costJpy < 1 ? 3 : 1)}円 ($${meta.costUsd.toFixed(6)})`
    : "";
  return `AI: ${meta.provider} \`${meta.model}\`${fallback}${size}${duration}${cost}`;
}

async function puterChat(prompt, model, label, userId = null) {
  if (shouldUseOpenRouter(model)) return openRouterChat(prompt, model, label, userId);
  const puter = await getPuter(userId);
  const startedAt = Date.now();
  console.log(`[AI] ${label} start model=${model}`);
  try {
    const response = await withTimeout(puter.ai.chat(prompt, { model }), `puter.ai.chat ${model}`);
    console.log(`[AI] ${label} done ${Date.now() - startedAt}ms`);
    return response;
  } catch (error) {
    console.error(`[AI] ${label} failed after ${Date.now() - startedAt}ms:`, error?.stack || error);
    if (isPuterAiCreditLimitError(error)) {
      if (userId && loadOpenRouterConfig(userId)?.fallbackEnabled) {
        console.warn(`[AI] ${label} falling back to OpenRouter for user=${userId}`);
        return openRouterChat(prompt, openRouterModelName(null, userId), label, userId);
      }
      error.message = `${puterAiCreditLimitMessage()}\n\n${error.message || error}`;
    }
    throw error;
  }
}

function buildReviewPrompt(code, programmingLanguage, projectContext) {
  return `
You are a strict senior code reviewer.

${BRAIN_AGENT_PROMPT}

Project context:
${projectContext || "No prior context."}

Language/framework:
${programmingLanguage}

Review this code:
\`\`\`${programmingLanguage}
${code}
\`\`\`

Respond in Japanese. Lead with concrete findings ordered by severity.
Include bugs, likely runtime errors, security/reliability risks, missing tests, edge cases, and concrete fix suggestions.
If there are no serious issues, say that clearly and mention remaining risks.
Use Review-tan as the lead voice, but incorporate Coder-tan, Designer-tan, and Tester-tan perspectives where relevant.
Keep the response concise enough for Discord.
`.trim();
}

function buildDebugPrompt(errorText, code, programmingLanguage, projectContext) {
  const codeBlock = code ? `\nRelated code:\n\`\`\`${programmingLanguage}\n${code}\n\`\`\`` : "";
  return `
You are a debugging assistant for software engineers.

${BRAIN_AGENT_PROMPT}

Project context:
${projectContext || "No prior context."}

Language/framework:
${programmingLanguage}

Error/log:
\`\`\`text
${errorText}
\`\`\`
${codeBlock}

Respond in Japanese. Explain the most likely cause, why it matches the error, what to check next, concrete fix steps, and corrected code if useful.
Do not overstate certainty when the pasted information is incomplete.
Use Tester-tan to reproduce, Review-tan to identify risk, and Coder-tan to propose the fix. Mention Designer-tan only for UI-related bugs.
`.trim();
}

function commandMemoryKey(interaction) {
  return `${interaction.guildId || "dm"}:${interaction.channelId}:${interaction.user.id}`;
}

function buildMemoryContext(interaction) {
  return (commandMemory.get(commandMemoryKey(interaction)) || []).join("\n").slice(-4000);
}

function rememberCommand(interaction, text) {
  const key = commandMemoryKey(interaction);
  const items = commandMemory.get(key) || [];
  items.push(text);
  commandMemory.set(key, items.slice(-12));
}

async function attachmentToText(attachment) {
  if (!attachment) return "";
  if (attachment.size > 1024 * 1024) throw new Error("添付ファイルが大きすぎます。1MB以下のテキストファイルにしてください。");
  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`添付ファイルを取得できませんでした: ${response.status}`);
  return (await response.text()).slice(0, 100000);
}

async function sendProjectResult(interaction, project, model, programmingLanguage) {
  await updateInteractionProgress(interaction, "ファイルをzip化して、プレビュー画像を作っています...");
  const attachments = await buildProjectAttachments(project);
  await updateInteractionProgress(interaction, "Google Drive連携を確認しています...");
  const links = await uploadAttachmentsToDrive(interaction.user.id, attachments).catch((error) => {
    console.error("Drive upload failed:", error.message);
    return [];
  });
  const driveText = links.length ? `\n\nGoogle Drive: 保存しました。\n${links.slice(0, 5).join("\n")}` : "";
  const brainText = formatBrainMeeting(project);
  const usageLine = aiUsageLine(project);
  const publicContent =
    `**${project.title}**\n${project.summary}${brainText}\n\n${project.files.length} files generated.\n言語/技術: \`${programmingLanguage}\`\nモデル: \`${model}\`${usageLine ? `\n${usageLine}` : ""}${driveText}`.slice(
      0,
      2000
    );
  const publishId = crypto.randomBytes(12).toString("hex");
  publishResults.set(publishId, {
    ownerId: interaction.user.id,
    channelId: interaction.channelId,
    content: publicContent,
    attachments: serializeAttachments(attachments),
    expiresAt: Date.now() + 30 * 60 * 1000,
  });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`publish:${publishId}`).setLabel("公開").setStyle(ButtonStyle.Primary)
  );
  await interaction.editReply({
    content: `${publicContent}\n\n引用/出典ファイル: \`ASSET_SOURCES.md\` / \`BRAIN_MEETING.md\`\nこの結果をチャンネルに出す場合は「公開」を押してください。`.slice(0, 2000),
    files: attachments,
    components: [row],
  });
}

function serializeAttachments(attachments) {
  return attachments.map((attachment) => ({
    name: attachment.name,
    buffer: Buffer.isBuffer(attachment.attachment) ? Buffer.from(attachment.attachment) : fs.readFileSync(attachment.attachment),
  }));
}

function makeAttachmentBuilders(items) {
  return items.map((item) => new AttachmentBuilder(Buffer.from(item.buffer), { name: item.name }));
}

function cleanupPublishResults() {
  const now = Date.now();
  for (const [id, result] of publishResults) {
    if (result.expiresAt <= now) publishResults.delete(id);
  }
}

function discoverAssetUrls(project) {
  const urls = new Set();
  const pattern = /https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|gif|webp|svg|avif)(?:\?[^\s"'<>]*)?/gi;
  for (const file of project.files) {
    for (const match of file.content.matchAll(pattern)) urls.add(match[0]);
  }
  return [...urls];
}

function assetSourcesMarkdown(project) {
  const lines = ["# Asset Sources", "", "## Declared Sources", ""];
  for (const source of project.asset_sources) {
    lines.push(`- Asset: ${source.asset || "asset"}`);
    lines.push(`  Source: ${source.source || "none"}`);
    lines.push(`  License/Note: ${source.license || "not provided"}`);
  }
  lines.push("", "## Detected Image URLs", "");
  const urls = discoverAssetUrls(project);
  if (urls.length) lines.push(...urls.map((url) => `- ${url}`));
  else lines.push("- No external image URLs detected.");
  return `${lines.join("\n")}\n`;
}

function brainMeetingMarkdown(project) {
  const lines = ["# Brain Meeting", ""];
  for (const item of normalizeBrainMeeting(project.brain_meeting)) {
    lines.push(`[${item.agent}]`);
    lines.push(`「${item.comment}」`, "");
  }
  return `${lines.join("\n")}\n`;
}

function formatBrainMeeting(project, maxLength = 650) {
  const lines = normalizeBrainMeeting(project.brain_meeting).map((item) => `[${item.agent}]\n「${item.comment}」`);
  return lines.length ? `\n\n**脳内会議**\n${lines.join("\n")}`.slice(0, maxLength) : "";
}

async function buildProjectAttachments(project) {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "discoder-node-project-"));
  const projectDir = path.join(workDir, "project");
  await fsp.mkdir(projectDir, { recursive: true });

  for (const file of project.files) {
    const dest = path.join(projectDir, file.path);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, file.content, "utf8");
  }
  await fsp.writeFile(path.join(projectDir, "ASSET_SOURCES.md"), assetSourcesMarkdown(project), "utf8");
  await fsp.writeFile(path.join(projectDir, "BRAIN_MEETING.md"), brainMeetingMarkdown(project), "utf8");

  const zip = new JSZip();
  async function addDir(dir, root = dir) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await addDir(full, root);
      else zip.file(path.relative(root, full).replace(/\\/g, "/"), await fsp.readFile(full));
    }
  }
  await addDir(projectDir);
  const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const attachments = [
    new AttachmentBuilder(zipBuffer, { name: `${safeName(project.title)}.zip` }),
    new AttachmentBuilder(Buffer.from(assetSourcesMarkdown(project), "utf8"), { name: "ASSET_SOURCES.md" }),
    new AttachmentBuilder(Buffer.from(brainMeetingMarkdown(project), "utf8"), { name: "BRAIN_MEETING.md" }),
  ];

  const preview = await findPreviewPath(project, projectDir);
  if (preview) {
    const screenshot = await screenshotHtml(preview);
    if (screenshot) attachments.push(new AttachmentBuilder(screenshot, { name: "preview.png" }));
  }
  await fsp.rm(workDir, { recursive: true, force: true });
  return attachments;
}

async function findPreviewPath(project, projectDir) {
  if (project.preview_file) {
    const candidate = path.join(projectDir, project.preview_file);
    if (candidate.startsWith(projectDir) && fs.existsSync(candidate) && /\.html?$/i.test(candidate)) return candidate;
  }
  const stack = [projectDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.html?$/i.test(entry.name)) return full;
    }
  }
  return null;
}

async function screenshotHtml(htmlPath) {
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });
    return await page.screenshot({ fullPage: true });
  } catch (error) {
    console.error("preview screenshot failed:", error.message);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

function hasWakeWord(text) {
  return WAKE_PATTERNS.some((pattern) => pattern.test(text));
}

function stripWakeWord(text) {
  let output = text.trim();
  for (const pattern of WAKE_PATTERNS) output = output.replace(pattern, "").trim();
  return output
    .replace(/^(?:たん|さん|ちゃん|tan)(?=\s|[、。,.!！?？:：;；\-ー〜～]|画像|動画|イラスト|絵|アイコン|サムネ|壁紙|ビデオ|映像|image|video|picture|movie)/i, "")
    .replace(/^[、。!！?？:：\s-]+/, "")
    .trim();
}

function normalizeRecognizedWakeText(text) {
  return text
    .normalize("NFKC")
    .replace(/[　\s]+/g, "")
    .toLowerCase();
}

function hasRecognizedWakeWord(text) {
  const normalized = normalizeRecognizedWakeText(text);
  return /(?:コーダー|コーダ|こーだー|こーだ|こうだー|こうだ|こだー|こだ|こら|おら|おーら|オーダー|おーだー|オーダ|おーだ|おだー|order)(?:たん|さん|ちゃん|tan)?/.test(normalized);
}

function stripRecognizedWakeWord(text) {
  let output = text.trim();
  output = output.replace(/(?:オーダー|おーだー|オーダ|おーだ|おだー|order)\s*(?:たん|さん|ちゃん|tan)?/i, "");
  output = output.replace(/(?:コー?\s*ダー?|こー?\s*だー?|こう\s*だー?|こ\s*だー?|こら|おら|おーら)\s*(?:たん|さん|ちゃん)?/i, "");
  return output
    .replace(/^(?:たん|さん|ちゃん|tan)(?=\s|[、。,.!！?？:：;；\-ー〜～]|画像|動画|イラスト|絵|アイコン|サムネ|壁紙|ビデオ|映像|image|video|picture|movie)/i, "")
    .replace(/^[\s、。,.!！?？:：;；\-ー〜～]+/, "")
    .trim();
}

function isLeaveRequest(text) {
  return /\b(leave|disconnect|stop)\b|終了|退出|切断/i.test(text);
}

function isCompleteRequest(text) {
  return /^(?:これで)?\s*(?:完成|完了|仕上げ|final|done|complete)\s*(?:して|お願い|です|だよ|[!！。.]*)?$/i.test(text.trim());
}

function findVoiceChannel(message) {
  const mentioned = message.mentions.channels.find((channel) => channel.isVoiceBased());
  if (mentioned) return mentioned;
  return message.member?.voice?.channel || null;
}

function findInteractionVoiceChannel(interaction) {
  const selected = interaction.options.getChannel("channel");
  if (selected?.isVoiceBased()) return selected;
  return interaction.member?.voice?.channel || null;
}

function isBotMentioned(message) {
  const id = client.user?.id;
  if (!id) return false;
  if (message.mentions.users.has(id)) return true;
  if (message.mentions.repliedUser?.id === id) return true;
  if (message.content.includes(`<@${id}>`) || message.content.includes(`<@!${id}>`)) return true;
  const username = client.user?.username;
  return Boolean(username && new RegExp(`(^|\\s)@?${escapeRegExp(username)}(?=\\s|$)`, "i").test(message.content));
}

function stripBotMention(text) {
  const id = client.user?.id;
  let output = String(text || "");
  if (id) output = output.replace(new RegExp(`<@!?${escapeRegExp(id)}>`, "g"), "");
  const username = client.user?.username;
  if (username) output = output.replace(new RegExp(`(^|\\s)@?${escapeRegExp(username)}(?=\\s|$)`, "ig"), "$1");
  return output.trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function googleOAuthConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function googleRedirectUri() {
  if (process.env.GOOGLE_PUBLIC_BASE_URL) {
    return `${process.env.GOOGLE_PUBLIC_BASE_URL.replace(/\/+$/, "")}/oauth2callback`;
  }
  return process.env.GOOGLE_REDIRECT_URI || "http://localhost:8080/oauth2callback";
}

function publicBaseUrl() {
  if (process.env.GOOGLE_PUBLIC_BASE_URL) return process.env.GOOGLE_PUBLIC_BASE_URL.replace(/\/+$/, "");
  const redirect = process.env.GOOGLE_REDIRECT_URI || "";
  if (/^https?:\/\//i.test(redirect)) {
    const url = new URL(redirect);
    return `${url.protocol}//${url.host}`;
  }
  return "";
}

function googleDriveFolderName() {
  return process.env.GOOGLE_DRIVE_FOLDER_NAME || "DisCoder";
}

function loadDriveTokens() {
  try {
    return JSON.parse(fs.readFileSync(NODE_DRIVE_TOKEN_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveDriveTokens(tokens) {
  fs.writeFileSync(NODE_DRIVE_TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf8");
}

function createOAuthClient() {
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, googleRedirectUri());
}

function startDriveOAuthServer() {
  if (!googleOAuthConfigured() && !publicBaseUrl()) return;
  if (driveOAuthServerStarted) return;
  driveOAuthServerStarted = true;
  const url = new URL(googleOAuthConfigured() ? googleRedirectUri() : `${publicBaseUrl()}/puter-auth`);
  const port = Number(process.env.GOOGLE_OAUTH_PORT || url.port || 8080);
  const host = process.env.GOOGLE_OAUTH_HOST || "::";
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    if (requestUrl.pathname === "/puter-auth") {
      const state = requestUrl.searchParams.get("state");
      const token = requestUrl.searchParams.get("token");
      const userId = PUTER_AUTH_STATES.get(state);
      if (!state || !token || !userId) {
        res.writeHead(400);
        res.end("Invalid or expired Puter auth state.");
        return;
      }
      PUTER_AUTH_STATES.delete(state);
      savePuterUserToken(userId, token);
      res.end("Puter connection completed. You can return to Discord.");
      return;
    }
    if (requestUrl.pathname !== "/oauth2callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    if (!googleOAuthConfigured()) {
      res.writeHead(404);
      res.end("Google OAuth is not configured.");
      return;
    }
    const state = requestUrl.searchParams.get("state");
    const code = requestUrl.searchParams.get("code");
    const userId = OAUTH_STATES.get(state);
    if (!state || !code || !userId) {
      res.writeHead(400);
      res.end("Invalid or expired OAuth state.");
      return;
    }
    OAUTH_STATES.delete(state);
    try {
      const oauth = createOAuthClient();
      const { tokens } = await oauth.getToken(code);
      const allTokens = loadDriveTokens();
      allTokens[userId] = tokens;
      saveDriveTokens(allTokens);
      res.end("Google Drive connection completed. You can return to Discord.");
    } catch (error) {
      res.writeHead(500);
      res.end(`Google Drive connection failed: ${error.message}`);
    }
  });
  server.on("error", (error) => {
    driveOAuthServerStarted = false;
    console.error("Google OAuth callback failed:", error.message);
  });
  server.listen(port, host, () => console.log(`OAuth callback listening on ${host}:${port}`));
}

async function getDriveClient(userId) {
  if (!googleOAuthConfigured()) return null;
  const tokens = loadDriveTokens()[userId];
  if (!tokens) return null;
  const oauth = createOAuthClient();
  oauth.setCredentials(tokens);
  oauth.on("tokens", (newTokens) => {
    const allTokens = loadDriveTokens();
    allTokens[userId] = { ...allTokens[userId], ...newTokens };
    saveDriveTokens(allTokens);
  });
  return google.drive({ version: "v3", auth: oauth });
}

async function ensureDriveFolder(drive) {
  const name = googleDriveFolderName();
  const escaped = name.replace(/'/g, "\\'");
  const result = await drive.files.list({
    q: `name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    spaces: "drive",
    fields: "files(id,name)",
    pageSize: 1,
  });
  if (result.data.files?.length) return result.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder" },
    fields: "id",
  });
  return created.data.id;
}

async function uploadAttachmentsToDrive(userId, attachments) {
  const drive = await getDriveClient(userId);
  if (!drive) return [];
  const folderId = await ensureDriveFolder(drive);
  const links = [];
  for (const attachment of attachments) {
    const file = attachment.attachment;
    const buffer = Buffer.isBuffer(file) ? file : fs.readFileSync(file);
    const created = await drive.files.create({
      requestBody: { name: attachment.name, parents: [folderId] },
      media: { mimeType: attachment.name.endsWith(".png") ? "image/png" : "application/zip", body: require("stream").Readable.from(buffer) },
      fields: "id,name,webViewLink",
    });
    links.push(created.data.webViewLink || `https://drive.google.com/file/d/${created.data.id}/view`);
  }
  return links;
}

function pcmStereoToWavBuffer(pcm) {
  const result = childProcess.spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-i",
      "pipe:0",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-f",
      "wav",
      "pipe:1",
    ],
    { input: pcm, maxBuffer: 32 * 1024 * 1024 }
  );
  if (result.status !== 0) throw new Error(result.stderr.toString("utf8"));
  return result.stdout;
}

function pcmStereoToWavDataUrl(pcm) {
  return `data:audio/wav;base64,${pcmStereoToWavBuffer(pcm).toString("base64")}`;
}

function saveDebugWav(userId, pcm) {
  const file = path.join(os.tmpdir(), `discoder-node-bot-stt-${userId}-${Date.now()}.wav`);
  childProcess.spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0", file],
    { input: pcm, maxBuffer: 32 * 1024 * 1024 }
  );
  return file;
}

function pcmRms16le(buffer) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const sample = buffer.readInt16LE(i);
    sum += sample * sample;
    count += 1;
  }
  return Math.round(Math.sqrt(sum / Math.max(count, 1)));
}

async function transcribePcm(pcm) {
  if (TALK_CODING_STT_PROVIDER === "local_whisper" || TALK_CODING_STT_PROVIDER === "whisper") {
    return transcribePcmWithLocalWhisper(pcm);
  }
  return transcribePcmWithPuter(pcm);
}

async function transcribePcmWithLocalWhisper(pcm) {
  const started = Date.now();
  const wav = pcmStereoToWavBuffer(pcm);
  if (LOCAL_WHISPER_PERSISTENT) {
    const raw = await transcribeWavWithLocalWhisperWorker(wav);
    raw.elapsed_ms = Date.now() - started;
    return { text: extractText(raw).trim(), raw, model: raw.model || "local_whisper" };
  }
  const result = childProcess.spawnSync(LOCAL_WHISPER_PYTHON, [path.join(__dirname, "local_whisper_stt.py")], {
    input: wav,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: LOCAL_WHISPER_TIMEOUT_MS,
    env: {
      ...process.env,
      TALK_CODING_STT_LANGUAGE_CODE: STT_LANGUAGE,
    },
  });
  const stdout = String(result.stdout || "").trim();
  let raw;
  try {
    raw = stdout ? JSON.parse(stdout) : {};
  } catch {
    raw = { error: "invalid_json", stdout };
  }
  if (result.error) raw = { ...raw, error: "spawn_failed", message: result.error.message };
  if (result.status && !raw.error) raw = { ...raw, error: "process_failed", status: result.status, stderr: result.stderr };
  raw.elapsed_ms = Date.now() - started;
  return { text: extractText(raw).trim(), raw, model: raw.model || "local_whisper" };
}

function getLocalWhisperWorker() {
  if (localWhisperWorker?.process && !localWhisperWorker.process.killed) return localWhisperWorker;

  const workerPath = path.join(__dirname, "local_whisper_stt_worker.py");
  const proc = childProcess.spawn(LOCAL_WHISPER_PYTHON, [workerPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      TALK_CODING_STT_LANGUAGE_CODE: STT_LANGUAGE,
    },
  });
  const worker = {
    process: proc,
    stdout: "",
    pending: [],
  };
  localWhisperWorker = worker;

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (data) => {
    worker.stdout += data;
    let newline;
    while ((newline = worker.stdout.indexOf("\n")) !== -1) {
      const line = worker.stdout.slice(0, newline).trim();
      worker.stdout = worker.stdout.slice(newline + 1);
      if (!line) continue;
      const pending = worker.pending.shift();
      if (!pending) continue;
      clearTimeout(pending.timeout);
      try {
        pending.resolve(JSON.parse(line));
      } catch {
        pending.resolve({ text: "", error: "invalid_worker_json", stdout: line });
      }
    }
  });
  proc.stderr.on("data", (data) => {
    if (DEBUG_STT) console.error(`[local_whisper] ${String(data).trim()}`);
  });
  proc.on("exit", (code, signal) => {
    const error = new Error(`local_whisper worker exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    for (const pending of worker.pending.splice(0)) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    if (localWhisperWorker === worker) localWhisperWorker = null;
  });
  proc.on("error", (error) => {
    for (const pending of worker.pending.splice(0)) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    if (localWhisperWorker === worker) localWhisperWorker = null;
  });

  return worker;
}

function transcribeWavWithLocalWhisperWorker(wav) {
  const worker = getLocalWhisperWorker();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const index = worker.pending.findIndex((item) => item.resolve === resolve);
      if (index !== -1) worker.pending.splice(index, 1);
      reject(new Error(`local_whisper worker timed out after ${Math.round(LOCAL_WHISPER_TIMEOUT_MS / 1000)}s`));
    }, LOCAL_WHISPER_TIMEOUT_MS);
    worker.pending.push({ resolve, reject, timeout });
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(wav.length, 0);
    try {
      worker.process.stdin.write(Buffer.concat([header, wav]));
    } catch (error) {
      clearTimeout(timeout);
      worker.pending.pop();
      reject(error);
    }
  });
}

async function transcribePcmWithPuter(pcm) {
  const puter = await getPuter();
  const dataUrl = pcmStereoToWavDataUrl(pcm);
  const models = PUTER_STT_MODELS.length ? PUTER_STT_MODELS : [PUTER_STT_MODEL];
  let lastResult = null;
  for (const model of models) {
    try {
      const result = await puter.ai.speech2txt(dataUrl, {
        model,
        response_format: "json",
        language: STT_LANGUAGE,
        prompt: "Japanese Discord voice chat. The wake phrase may be コーダーたん.",
      });
      lastResult = result;
      if (result?.error || result?.code === "internal_error") continue;
      const text = extractText(result).trim();
      if (text) return { text, raw: result, model };
    } catch (error) {
      lastResult = {
        error: error?.error || error?.message || String(error),
        code: error?.code,
        model,
      };
    }
  }
  return { text: "", raw: lastResult, model: models[models.length - 1] };
}

function summarizeValue(value, depth = 0) {
  if (value == null) return String(value);
  if (typeof value === "string") return value.slice(0, 300);
  if (typeof value !== "object") return String(value);
  if (depth >= 2) return Array.isArray(value) ? `[array:${value.length}]` : `[object:${Object.keys(value).join(",")}]`;
  if (Array.isArray(value)) return `[${value.slice(0, 3).map((item) => summarizeValue(item, depth + 1)).join(", ")}]`;
  return `{${Object.entries(value)
    .slice(0, 8)
    .map(([key, item]) => `${key}:${summarizeValue(item, depth + 1)}`)
    .join(", ")}}`;
}

async function generateReply(session, userText, userId = session.ownerId) {
  const modeInstruction =
    session.mode === "chat"
      ? "You are Coder-tan in casual chat mode. Keep it light, friendly, and concise in Japanese. Do not generate full code unless explicitly asked."
      : `You are Coder-tan, a concise Japanese Discord VC coding assistant. Answer in Japanese. Generate code when useful. Keep replies short for TTS.

${BRAIN_AGENT_PROMPT}

For normal short answers, do the meeting internally and answer as Coder-tan. When a tradeoff or risk matters, include 1-3 short public lines like [レビューたん] or [テスターたん].`;
  const messages = [
    {
      role: "system",
      content: modeInstruction,
    },
    ...session.history.slice(-16),
    { role: "user", content: userText },
  ];
  const response = await puterChat(messages, PUTER_CHAT_MODEL, "talk reply", userId);
  const usageLine = aiUsageLine(response);
  return `${extractText(response).trim() || "うまく返答を作れなかったよ。"}${usageLine ? `\n\n${usageLine}` : ""}`;
}

async function synthesizeTts(text) {
  if (TALK_CODING_TTS_PROVIDER === "qwen" || TALK_CODING_TTS_PROVIDER === "dashscope") {
    return synthesizeQwenTts(toSpeechText(text));
  }
  return synthesizePuterTts(toSpeechText(text));
}

function toSpeechText(text) {
  const withoutCode = String(text || "")
    .replace(/```[\s\S]*?```/g, "コード部分はチャットに書いたよ。")
    .replace(/<[^>\n]{1,80}>/g, "")
    .replace(/[{}[\]();<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const readable = applyJapaneseTtsReadings(withoutCode);
  if (readable.length <= TTS_MAX_CHARS) return readable;
  return `${readable.slice(0, TTS_MAX_CHARS)}。続きはチャットを見てね。`;
}

function applyJapaneseTtsReadings(text) {
  return String(text || "")
    .replace(/了解/g, "りょうかい")
    .replace(/動く/g, "うごく")
    .replace(/動か/g, "うごか")
    .replace(/動き/g, "うごき")
    .replace(/実行/g, "じっこう")
    .replace(/保存/g, "ほぞん")
    .replace(/作成/g, "さくせい")
    .replace(/生成/g, "せいせい")
    .replace(/修正/g, "しゅうせい")
    .replace(/確認/g, "かくにん")
    .replace(/設定/g, "せってい")
    .replace(/追加/g, "ついか")
    .replace(/変更/g, "へんこう")
    .replace(/完了/g, "かんりょう")
    .replace(/起動/g, "きどう")
    .replace(/接続/g, "せつぞく")
    .replace(/音声/g, "おんせい")
    .replace(/認識/g, "にんしき")
    .replace(/読み上げ/g, "よみあげ")
    .replace(/大丈夫/g, "だいじょうぶ")
    .replace(/問題/g, "もんだい")
    .replace(/基本/g, "きほん");
}

function synthesizeQwenTts(text) {
  const file = path.join(os.tmpdir(), `discoder-qwen-tts-${Date.now()}.mp3`);
  const result = childProcess.spawnSync(
    QWEN_TTS_PYTHON,
    [path.join(__dirname, "qwen3_tts_flash.py"), "--stdin", "-o", file],
    {
      input: text.slice(0, 2800),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: QWEN_TTS_TIMEOUT_MS,
      env: process.env,
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `Qwen TTS failed with exit ${result.status}`).toString().trim());
  }
  try {
    return fs.readFileSync(file);
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

async function synthesizePuterTts(text) {
  const puter = await getPuter();
  const audio = await puter.ai.txt2speech(text.slice(0, 2800), {
    provider: PUTER_TTS_PROVIDER,
    model: PUTER_TTS_MODEL,
    voice: PUTER_TTS_VOICE,
    language: "ja-JP",
  });

  if (audio?.arrayBuffer) return Buffer.from(await audio.arrayBuffer());
  const source = audio?.src || audio?.url || (typeof audio === "string" ? audio : null);
  if (source?.startsWith("data:")) return Buffer.from(source.split(",", 2)[1], "base64");
  if (source) {
    const response = await fetch(source);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error("Puter TTS returned unsupported audio.");
}

async function playTts(session, text) {
  try {
    const audio = await synthesizeTts(text);
    const file = path.join(os.tmpdir(), `discoder-puter-tts-${Date.now()}.mp3`);
    fs.writeFileSync(file, audio);
    const resource = createAudioResource(file, { inputType: StreamType.Arbitrary });
    session.player.play(resource);
    session.player.once(AudioPlayerStatus.Idle, () => fs.rm(file, { force: true }, () => {}));
  } catch (error) {
    await session.textChannel.send(`TTSに失敗しました: \`${error.message}\``);
  }
}

async function waitForVoiceReady(connection, guildId) {
  const deadline = Date.now() + 60000;
  let attempts = 0;
  while (Date.now() < deadline) {
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15000);
      return;
    } catch (error) {
      attempts += 1;
      const state = connection.state;
      console.error(
        `[voice] ready wait attempt ${attempts} failed guild=${guildId} state=${state.status}: ${error.message}`
      );
      if (state.status === VoiceConnectionStatus.Destroyed) throw error;
      if (state.status === VoiceConnectionStatus.Disconnected) {
        const canReconnect =
          state.reason === VoiceConnectionDisconnectReason.WebSocketClose && state.closeCode === 4014
            ? false
            : typeof connection.rejoin === "function";
        if (!canReconnect) throw error;
        try {
          const rejoining = connection.rejoin();
          console.log(`[voice] rejoin requested guild=${guildId} result=${rejoining}`);
        } catch (rejoinError) {
          console.error(`[voice] rejoin failed guild=${guildId}:`, rejoinError?.stack || rejoinError);
        }
      } else if (state.status === VoiceConnectionStatus.Signalling || state.status === VoiceConnectionStatus.Connecting) {
        console.log(`[voice] still ${state.status}; waiting without rejoin guild=${guildId}`);
      }
    }
  }
  throw new Error(`Voice connection did not become ready. Last state: ${connection.state.status}`);
}

function attachVoiceConnectionKeepAlive(connection, guildId) {
  let reconnectTimer = null;
  let reconnecting = false;

  const stopReconnectLoop = () => {
    if (reconnectTimer) clearInterval(reconnectTimer);
    reconnectTimer = null;
  };

  const tryReconnect = async () => {
    if (reconnecting || connection.state.status === VoiceConnectionStatus.Destroyed) return;
    if (connection.state.status === VoiceConnectionStatus.Ready) {
      stopReconnectLoop();
      return;
    }
    reconnecting = true;
    try {
      connection.rejoin();
      await entersState(connection, VoiceConnectionStatus.Ready, VOICE_RECONNECT_READY_TIMEOUT_MS);
      console.log(`[voice] reconnected guild=${guildId}`);
      stopReconnectLoop();
    } catch (error) {
      console.error(`[voice] reconnect failed guild=${guildId}:`, error?.stack || error);
    } finally {
      reconnecting = false;
    }
  };

  connection.on("stateChange", async (_oldState, newState) => {
    if (newState.status === VoiceConnectionStatus.Ready) {
      stopReconnectLoop();
      return;
    }
    if (newState.status !== VoiceConnectionStatus.Disconnected) return;
    if (connection.state.status === VoiceConnectionStatus.Destroyed) return;
    const movedOrKicked =
      newState.reason === VoiceConnectionDisconnectReason.WebSocketClose && newState.closeCode === 4014;
    if (movedOrKicked) {
      try {
        await entersState(connection, VoiceConnectionStatus.Signalling, 5000);
        return;
      } catch {
      }
    }
    if (!reconnectTimer) reconnectTimer = setInterval(() => tryReconnect(), VOICE_RECONNECT_INTERVAL_MS);
    await tryReconnect();
  });
}

function shouldReceiveUser(session, userId) {
  if (VOICE_RECEIVE_USER_IDS.size === 0) return true;
  if (VOICE_RECEIVE_USER_IDS.has(userId)) return true;
  if (DEBUG_STT) session.textChannel.send(`[STT] ignored ${userId}; not in TALK_CODING_RECEIVE_USER_IDS`).catch(() => {});
  return false;
}

function createPcmReceiveStream(connection, userId, endBehavior = { behavior: EndBehaviorType.AfterSilence, duration: STT_END_SILENCE_MS }) {
  const opus = connection.receiver.subscribe(userId, { end: endBehavior });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const pcm = opus.pipe(decoder);
  return { opus, decoder, pcm };
}

async function startTalkSession(message, voiceChannel) {
  const existing = sessions.get(message.guild.id);
  if (existing) {
    if (existing.ownerId !== message.author.id) {
      await message.reply("このサーバーでは別のトークコーディングが進行中です。開始した人が終了してから使ってください。");
      return null;
    }
    await stopTalkSession(message.guild.id);
  }

  const waitMessage = await message.reply("しばらくお待ちください。");
  const staleConnection = getVoiceConnection(message.guild.id);
  if (staleConnection) {
    staleConnection.destroy();
  }
  const staleGroupedConnection = getVoiceConnection(message.guild.id, message.guild.id);
  if (staleGroupedConnection) {
    staleGroupedConnection.destroy();
  }
  const player = createAudioPlayer();
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: message.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    group: message.guild.id,
    daveEncryption: true,
    decryptionFailureTolerance: VOICE_DECRYPTION_FAILURE_TOLERANCE,
    debug: DEBUG_STT,
    selfDeaf: false,
    selfMute: false,
  });
  connection.on("debug", (debugMessage) => {
    console.log(`[voice debug] ${message.guild.id}: ${debugMessage}`);
  });
  connection.on("stateChange", (oldState, newState) => {
    console.log(`[voice] ${message.guild.id}: ${oldState.status} -> ${newState.status}`);
    if (newState.status === VoiceConnectionStatus.Disconnected) {
      console.log(
        `[voice] disconnected reason=${newState.reason ?? "unknown"} closeCode=${newState.closeCode ?? "none"}`
      );
    }
  });
  attachVoiceConnectionKeepAlive(connection, message.guild.id);
  connection.subscribe(player);
  try {
    await waitForVoiceReady(connection, message.guild.id);
  } catch (error) {
    console.error("[voice] Ready wait failed:", error?.stack || error);
    connection.destroy();
    await waitMessage.edit("VC接続が完了しませんでした。BotをVCから切断して、もう一度メンションしてください。");
    return null;
  }

  const session = {
    ownerId: message.author.id,
    guildId: message.guild.id,
    textChannel: message.channel,
    textChannelId: message.channel.id,
    voiceChannelId: voiceChannel.id,
    connection,
    player,
    history: [],
    mode: "coding",
    armedUntil: 0,
    subscriptions: new Map(),
    busy: false,
  };
  sessions.set(message.guild.id, session);
  if (STT_SCAN_SUBSCRIBE) {
    subscribeMembers(session);
    session.scanTimer = setInterval(() => subscribeMembers(session), 2000);
  }
  connection.receiver.speaking.on("start", (userId) => subscribeUser(session, userId));
  connection.receiver.speaking.on("start", (userId) => {
    if (DEBUG_STT) session.textChannel.send(`[STT] speaking start ${userId}`).catch(() => {});
  });
  connection.receiver.speaking.on("end", (userId) => {
    if (DEBUG_STT) session.textChannel.send(`[STT] speaking end ${userId}`).catch(() => {});
  });
  attachVoiceReceiveDiagnostics(session);

  await reportVoiceDiagnostics(session, voiceChannel);
  await waitMessage.edit(
    `Coderたんが ${voiceChannel} に参加しました。現在はコーディングモードです。VCで「コーダーたん！」と呼ぶか、このチャンネルでメンションしてください。「雑談モード」「コーディングモード」で切り替えできます。\n\n${SUPPORT_NOTICE}`
  );
  return session;
}

async function startTalkSessionFromInteraction(interaction, voiceChannel) {
  const bridgeMessage = {
    guild: interaction.guild,
    guildId: interaction.guildId,
    author: interaction.user,
    member: interaction.member,
    channel: interaction.channel,
    reply: async (content) => {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(content);
      } else {
        await interaction.reply(content);
      }
      return {
        edit: (nextContent) => interaction.editReply(nextContent),
      };
    },
  };
  return startTalkSession(bridgeMessage, voiceChannel);
}

function attachVoiceReceiveDiagnostics(session) {
  if (!DEBUG_STT || session.receiverDiagnosticsAttached) return;
  session.receiverDiagnosticsAttached = true;
  const receiver = session.connection.receiver;
  receiver.ssrcMap.on("create", (data) => {
    session.textChannel.send(`[STT] ssrc create user=${data.userId} audio=${data.audioSSRC}`).catch(() => {});
  });
  receiver.ssrcMap.on("update", (_oldData, data) => {
    session.textChannel.send(`[STT] ssrc update user=${data.userId} audio=${data.audioSSRC}`).catch(() => {});
  });
  receiver.ssrcMap.on("delete", (data) => {
    session.textChannel.send(`[STT] ssrc delete user=${data.userId} audio=${data.audioSSRC}`).catch(() => {});
  });
  session.receiverDiagTimer = setInterval(() => {
    const ssrcSize = receiver.ssrcMap?.map?.size ?? "unknown";
    const subSize = receiver.subscriptions?.size ?? "unknown";
    const mode = receiver.connectionData?.encryptionMode || "none";
    const state = session.connection.state?.status || "unknown";
    session.textChannel
      .send(`[STT] receiver status state=${state} ssrc=${ssrcSize} subscriptions=${subSize} encryption=${mode}`)
      .catch(() => {});
  }, 10000);
}

async function reportVoiceDiagnostics(session, voiceChannel) {
  if (!DEBUG_STT) return;
  const me = voiceChannel.guild.members.me || (await voiceChannel.guild.members.fetchMe().catch(() => null));
  const perms = me ? voiceChannel.permissionsFor(me) : null;
  const voiceState = me?.voice;
  const lines = [
    "[VC diagnostics]",
    `node=${process.version}`,
    `state=${session.connection.state?.status || "unknown"}`,
    `encryption=${session.connection.receiver.connectionData?.encryptionMode || "none"}`,
    `libsodium=${hasModule("libsodium-wrappers") || hasModule("sodium-native") ? "ok" : "missing"}`,
    `opus=${hasModule("@discordjs/opus") || hasModule("node-opus") || hasModule("opusscript") ? "ok" : "missing"}`,
    `view=${perms?.has(PermissionFlagsBits.ViewChannel) ? "ok" : "missing"}`,
    `connect=${perms?.has(PermissionFlagsBits.Connect) ? "ok" : "missing"}`,
    `speak=${perms?.has(PermissionFlagsBits.Speak) ? "ok" : "missing"}`,
    `use_vad=${perms?.has(PermissionFlagsBits.UseVAD) ? "ok" : "missing"}`,
    `self_deaf=${voiceState?.selfDeaf ? "yes" : "no"}`,
    `server_deaf=${voiceState?.serverDeaf ? "yes" : "no"}`,
    `self_mute=${voiceState?.selfMute ? "yes" : "no"}`,
    `server_mute=${voiceState?.serverMute ? "yes" : "no"}`,
  ];
  await session.textChannel.send(lines.join("\n")).catch(() => {});
}

function subscribeMembers(session) {
  if (!opusReceiveAvailable) return;
  const guild = client.guilds.cache.get(session.guildId);
  const channel = guild?.channels.cache.get(session.voiceChannelId);
  if (!channel?.members) return;
  for (const [userId, member] of channel.members) {
    if (!member.user.bot) subscribeUser(session, userId, "scan");
  }
}

function subscribeUser(session, userId, reason = "speaking start") {
  if (!opusReceiveAvailable) return;
  if (!shouldReceiveUser(session, userId)) return;
  if (session.subscriptions.has(userId)) return;
  let opus;
  let decoder;
  try {
    ({ opus, decoder } = createPcmReceiveStream(session.connection, userId));
  } catch (error) {
    opusReceiveAvailable = false;
    console.error("[STT] Opus decoder is not available:", error?.message || error);
    session.textChannel
      .send("VC音声認識に必要なOpusデコーダがありません。`npm.cmd install` で `opusscript` を入れるまで、音声認識だけ無効にして続行します。")
      .catch(() => {});
    opus?.destroy?.();
    return;
  }
  const record = {
    opus,
    decoder,
    chunks: [],
    bytes: 0,
    finalized: false,
    silenceTimer: null,
    maxTimer: setTimeout(() => finishVoiceSubscription(session, userId, "recording window"), STT_MAX_RECORDING_MS),
    destroy() {
      clearTimeout(this.silenceTimer);
      clearTimeout(this.maxTimer);
      this.opus.destroy?.();
      this.decoder.destroy?.();
    },
  };
  session.subscriptions.set(userId, record);
  if (DEBUG_STT) session.textChannel.send(`[STT] subscribed ${userId} (${reason})`).catch(() => {});

  decoder.on("data", (chunk) => {
    if (record.finalized) return;
    record.chunks.push(chunk);
    record.bytes += chunk.length;
    clearTimeout(record.silenceTimer);
    record.silenceTimer = setTimeout(() => finishVoiceSubscription(session, userId, "pcm silence"), STT_END_SILENCE_MS);
  });
  decoder.on("end", () => {
    if (DEBUG_STT) session.textChannel.send(`[STT] decoder ended ${userId} bytes=${record.bytes}`).catch(() => {});
  });
  opus.on("close", () => {
    if (DEBUG_STT) session.textChannel.send(`[STT] opus closed ${userId} bytes=${record.bytes}`).catch(() => {});
  });
  opus.on("end", () => {
    if (DEBUG_STT) session.textChannel.send(`[STT] opus ended ${userId} bytes=${record.bytes}`).catch(() => {});
  });
  opus.on("error", (error) => {
    if (DEBUG_STT) session.textChannel.send(`[STT] opus error ${userId}: ${error.message}`).catch(() => {});
    session.subscriptions.delete(userId);
  });
}

function finishVoiceSubscription(session, userId, reason) {
  const record = session.subscriptions.get(userId);
  if (!record || record.finalized) return;
  record.finalized = true;
  clearTimeout(record.silenceTimer);
  clearTimeout(record.maxTimer);
  session.subscriptions.delete(userId);
  if (DEBUG_STT) session.textChannel.send(`[STT] finish ${userId}: ${reason} bytes=${record.bytes}`).catch(() => {});
  try {
    record.opus.unpipe(record.decoder);
  } catch {
  }
  record.opus.destroy?.();
  record.decoder.destroy?.();
  const pcm = Buffer.concat(record.chunks, record.bytes);
  handleVoiceChunk(session, userId, pcm).catch((error) => {
    session.textChannel.send(`[STT] error: ${error.message}`).catch(() => {});
  });
}

async function handleVoiceChunk(session, userId, pcm) {
  if (!sessions.has(session.guildId)) return;
  if (pcm.length < 48000) {
    if (DEBUG_STT) await session.textChannel.send(`[STT] skipped short audio bytes=${pcm.length}`);
    return;
  }
  const seconds = pcm.length / (48000 * 2 * 2);
  const rms = pcmRms16le(pcm);
  if (DEBUG_STT) await session.textChannel.send(`[STT] ${seconds.toFixed(1)}s bytes=${pcm.length} rms=${rms}`);
  if (rms < 180) {
    if (DEBUG_STT) await session.textChannel.send(`[STT] skipped quiet audio rms=${rms}`);
    return;
  }
  if (SAVE_STT_AUDIO) {
    const file = saveDebugWav(userId, pcm);
    if (DEBUG_STT) console.log(`[STT] saved debug wav: ${file}`);
  }

  if (DEBUG_STT) await session.textChannel.send(`[STT] sending audio to ${TALK_CODING_STT_PROVIDER} STT...`);
  const sttStarted = Date.now();
  const transcript = await transcribePcm(pcm);
  const text = transcript.text;
  if (DEBUG_STT) {
    await session.textChannel
      .send(
        `[STT] ${TALK_CODING_STT_PROVIDER} result model=${transcript.model || "unknown"} elapsed=${Date.now() - sttStarted}ms text=${text || "(empty)"}`
          .slice(0, 1900)
      )
      .catch(() => {});
  }
  if (!text) {
    if (DEBUG_STT) {
      await session.textChannel
        .send(`[STT] transcript empty model=${transcript.model || "unknown"} raw=${summarizeValue(transcript.raw)}`.slice(0, 1900));
    }
    return;
  }
  const member = await session.textChannel.guild.members.fetch(userId).catch(() => null);
  if (!member || member.voice.channelId !== session.voiceChannelId) return;
  await session.textChannel.send(`[STT] ${member.displayName}: ${text}`).catch(() => {});
  await handleTalkText(session, member, text, true);
}

function shouldGenerateTalkProject(text) {
  const normalized = String(text || "").toLowerCase();
  return /(?:html5?|css|javascript|js|typescript|ts|python|react|vue|next\.?js|node\.?js|discord\.?py|コード|ソース|プログラム|アプリ|ゲーム|サイト|ページ|画面|ui|ファイル|zip|完成形|実装|作成|生成|作って|つくって|書いて|修正|変更|追加)/i.test(
    normalized
  );
}

function getRequestedTalkMode(text) {
  if (/(?:雑談|会話|おしゃべり|チャット)\s*モード/i.test(text)) return "chat";
  if (/(?:コーディング|コード|開発|制作|作業)\s*モード/i.test(text)) return "coding";
  return null;
}

function isImageRequest(text) {
  return /(?:画像|イラスト|絵|アイコン|サムネ|壁紙|image|picture|illust|生成|描いて|作って)/i.test(text) && /(?:画像|イラスト|絵|アイコン|サムネ|壁紙|image|picture|illust)/i.test(text);
}

function hasImageAttachment(attachments = []) {
  return attachments.some((attachment) => attachment.contentType?.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|tiff?)($|\?)/i.test(attachment.url));
}

function isImageToTextRequest(text, attachments = []) {
  return (
    hasImageAttachment(attachments) &&
    /(?:画像.*(?:文字|テキスト|読|認識|解析|分析|説明|見|何|なに|内容|わか|分か|判定|ocr)|(?:文字|テキスト).*(?:抽出|読|起こ)|(?:この|添付).*(?:認識|解析|分析|説明|見|何|なに|内容|わか|分か|判定)|img2txt|ocr|読み取|読んで|認識できる|何が写|なにが写|見える|説明して)/i.test(
      text
    )
  );
}

function isVideoRequest(text) {
  const normalized = String(text || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  return /(?:動画|どうが|ドウガ|ビデオ|びでお|映像|えいぞう|ムービー|むーびー|video|movie|txt2vid)(?:を)?(?:生成|作成|作って|つくって|作れ|お願い|ください|して)?/.test(
    normalized
  );
}

function cleanupMediaPrompt(text, fallback) {
  let output = stripRecognizedWakeWord(stripWakeWord(String(text || "")));
  output = output
    .replace(/^(?:軽い|かるい)\s*/, "")
    .replace(/^(?:を|で|に)\s*/, "")
    .replace(/(?:を|で|に)?\s*(?:生成して|生成|作って|つくって|描いて|お願い|ください|して)\s*$/i, "")
    .replace(/^(?:生成して|作って|つくって|描いて|お願い|ください|して)\s*/i, "")
    .replace(/^[\s、。,.!！?？:：;；\-ー〜～]+|[\s、。,.!！?？:：;；\-ー〜～]+$/g, "")
    .trim();
  if (!output || /^(?:生成|作成|お願い|ください|して|作って|つくって|描いて)$/i.test(output)) return fallback;
  return output;
}

function extractImagePrompt(text) {
  return cleanupMediaPrompt(text, "画像");
}

function extractVideoPrompt(text) {
  return cleanupMediaPrompt(text, "動画")
    .replace(/^(?:どうが|ドウガ|びでお|えいぞう|ムービー|むーびー)$/i, "動画")
    .trim();
}

async function sendLoadingMessage(channel, initialText, intervalText) {
  const startedAt = Date.now();
  const message = await channel.send(initialText);
  const timer = setInterval(() => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    message.edit(`${intervalText} 経過 ${seconds} 秒`).catch(() => {});
  }, 15000);
  return {
    message,
    stop: () => clearInterval(timer),
    elapsedSeconds: () => Math.floor((Date.now() - startedAt) / 1000),
  };
}

async function sendTalkProjectResult(session, member, project) {
  const attachments = await buildProjectAttachments(project);
  const links = await uploadAttachmentsToDrive(member.id, attachments).catch((error) => {
    console.error("Drive upload failed:", error.message);
    return [];
  });
  const driveText = links.length ? `\nGoogle Drive: 保存しました。\n${links.slice(0, 5).join("\n")}` : "";
  const brainText = formatBrainMeeting(project);
  const usageLine = aiUsageLine(project);
  await session.textChannel.send({
    content: `**${project.title}**\n${project.summary}${brainText}\n\n${project.files.length} files generated with ${PUTER_CHAT_MODEL}.${usageLine ? `\n${usageLine}` : ""}${driveText}`.slice(0, 2000),
    files: attachments,
  });
}

async function sendTalkImageResult(session, text, userId = null) {
  const prompt = extractImagePrompt(text) || text;
  const loading = await sendLoadingMessage(session.textChannel, `画像を生成中... \`${prompt.slice(0, 120)}\``, "画像を生成中...");
  try {
    const attachment = await generateImageAttachment(prompt, userId);
    const usageLine = attachment.__discoder_ai ? aiUsageLine({ ai_meta: attachment.__discoder_ai }) : "";
    await loading.message.edit({
      content: `**画像生成**\n${prompt}\n完了: ${loading.elapsedSeconds()} 秒`.slice(0, 2000),
      files: [attachment],
    });
    if (usageLine) await session.textChannel.send(usageLine).catch(() => {});
  } finally {
    loading.stop();
  }
}

async function sendTalkVideoResult(session, text, userId = null, options = {}) {
  const prompt = extractVideoPrompt(text) || text;
  const model = puterVideoModelForDate();
  const requestedSize = options.size ? normalizeVideoSize(options.size) : extractVideoSize(text, openRouterMediaConfig(userId).videoSize);
  const requestedDuration = normalizeVideoDurationSeconds(options.duration || DEFAULT_VIDEO_DURATION_SECONDS);
  const notice = sora2MigrationNotice();
  const routeLabel = mediaRouteLabel(userId, "video", model);
  console.log(`[talk] txt2vid route prompt=${prompt.slice(0, 200)} route=${routeLabel}`);
  const loading = await sendLoadingMessage(
    session.textChannel,
    `動画を生成中... 経路: \`${routeLabel}\`\n${notice}\n\`${prompt.slice(0, 160)}\``,
    `動画を生成中... 経路: \`${routeLabel}\`\n${notice}`
  );
  try {
    await loading.message.edit(`動画生成APIを呼び出しています... 経路: \`${routeLabel}\`\n${notice}\n\`${prompt.slice(0, 160)}\``).catch(() => {});
    let result;
    let usageLine = "";
    try {
      result = await generateVideoAttachment(prompt, model, userId, requestedSize.size, requestedDuration);
      usageLine = aiUsageLine(result);
    } catch (error) {
      if (model === "sora-2" && (error.code === "insufficient_funds" || /insufficient[_\s-]?funds/i.test(error.message || ""))) {
        const fallbackModel = "veo-3.1-lite-generate-preview";
        await loading.message
          .edit(`Sora2の残高不足を検出しました。Google Veoに自動フォールバックします... モデル: \`${fallbackModel}\`\n\`${prompt.slice(0, 160)}\``)
          .catch(() => {});
        result = await generateVideoAttachment(prompt, fallbackModel, userId, requestedSize.size, requestedDuration);
        usageLine = aiUsageLine(result);
        result.fallbackFrom = model;
      } else {
        throw error;
      }
    }
    await loading.message.edit(`動画をDiscord添付に変換しています... モデル: \`${result.model}\``).catch(() => {});
    const fallbackText = result.fallbackFrom ? `\nSora2の残高不足により \`${result.model}\` に自動フォールバックしました。` : "";
    await loading.message.edit({
      content: `**動画生成**\nモデル: \`${result.model}\`${fallbackText}\n${notice}\n${prompt}\n完了: ${loading.elapsedSeconds()} 秒`.slice(0, 2000),
      files: [result.attachment],
    });
    if (usageLine) await session.textChannel.send(usageLine).catch(() => {});
  } catch (error) {
    await loading.message.edit(`動画生成は完了しましたが、Discord添付に変換できませんでした: \`${error.message}\``.slice(0, 2000)).catch(() => {});
    throw error;
  } finally {
    loading.stop();
  }
}

async function sendDirectVideoResult(channel, text) {
  await sendTalkVideoResult({ textChannel: channel }, text);
}

async function sendDirectVideoResultForUser(channel, text, userId) {
  await sendTalkVideoResult({ textChannel: channel }, text, userId);
}

async function sendDirectVideoResultForUserWithOptions(channel, text, userId, options = {}) {
  await sendTalkVideoResult({ textChannel: channel }, text, userId, options);
}

async function resolveInteractionTextChannel(interaction, channelId = interaction.channelId) {
  if (interaction.channel?.send) return interaction.channel;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (channel?.send) return channel;
  throw new Error("動画を投稿するチャンネルを取得できませんでした。Botにチャンネル閲覧・メッセージ送信権限があるか確認してください。");
}

async function sendTalkImageTextResult(session, text, attachments, userId = null) {
  const image = attachments.find((attachment) => attachment.contentType?.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|tiff?)($|\?)/i.test(attachment.url));
  if (!image) {
    await session.textChannel.send("読み取れる画像添付が見つかりませんでした。");
    return;
  }
  const loading = await sendLoadingMessage(session.textChannel, "画像の文字を読み取り中...", "画像の文字を読み取り中...");
  try {
    const result = await extractTextFromImageSource(image.url, userId);
    await loading.message.edit(`**画像文字読み取り**\n${result || "文字を検出できませんでした。"}`.slice(0, 2000));
  } finally {
    loading.stop();
  }
}

async function handleTalkText(session, member, rawText, fromVoice = false, options = {}) {
  let text = rawText.trim();
  if (fromVoice) {
    const hasWake = hasWakeWord(text) || hasRecognizedWakeWord(text);
    if (hasWake) {
      session.armedUntil = Date.now() + 15000;
      text = stripRecognizedWakeWord(stripWakeWord(text));
      const onlyWakeWord = !text || text.length <= 3 || /^(はい|うん|えっと|あの|ねえ|ねぇ|お願い|おねがい)$/i.test(text);
      if (onlyWakeWord) {
        await session.textChannel.send(`${member} 呼んだ？続けて話してね。`);
        return;
      }
    } else if (Date.now() > session.armedUntil) {
      return;
    }
  }

  const requestedMode = getRequestedTalkMode(text);
  if (requestedMode) {
    session.mode = requestedMode;
    const label = requestedMode === "chat" ? "雑談モード" : "コーディングモード";
    await session.textChannel.send(`${label}に切り替えました。`);
    await playTts(session, `${label}に切り替えたよ。`);
    return;
  }

  if (member.id === session.ownerId && isCompleteRequest(text)) {
    await completeTalkSession(session, member);
    return;
  }

  if (session.busy) {
    await session.textChannel.send("前の依頼を処理中です。少し待ってね。");
    return;
  }
  session.busy = true;
  try {
    const attachments = [...(options.attachments?.values?.() || options.attachments || [])];
    session.history.push({ role: "user", content: `${member.displayName}: ${text}` });
    if (isImageToTextRequest(text, attachments)) {
      await sendTalkImageTextResult(session, text, attachments, member.id);
      session.history.push({ role: "assistant", content: "画像から文字を読み取りました。" });
      session.history.splice(0, Math.max(0, session.history.length - 24));
      await playTts(session, "画像の文字を読み取ったよ。");
      return;
    }
    if (isVideoRequest(text)) {
      await sendTalkVideoResult(session, text, member.id);
      session.history.push({ role: "assistant", content: "動画を生成して投稿しました。" });
      session.history.splice(0, Math.max(0, session.history.length - 24));
      await playTts(session, "動画を送ったよ。");
      return;
    }
    if (isImageRequest(text)) {
      await sendTalkImageResult(session, text, member.id);
      session.history.push({ role: "assistant", content: "画像を生成して投稿しました。" });
      session.history.splice(0, Math.max(0, session.history.length - 24));
      await playTts(session, "画像を送ったよ。");
      return;
    }
    if (session.mode === "coding" && shouldGenerateTalkProject(text)) {
      await session.textChannel.send("zip付きの完成形を生成しています...");
      const project = await generateProject(session, text, member.id);
      await sendTalkProjectResult(session, member, project);
      const summary = `${project.title}: ${project.summary}`;
      session.history.push({ role: "assistant", content: summary });
      session.history.splice(0, Math.max(0, session.history.length - 24));
      await playTts(session, "完成形をzipで送ったよ。");
      return;
    }
    const reply = await generateReply(session, text, member.id);
    session.history.push({ role: "assistant", content: reply });
    session.history.splice(0, Math.max(0, session.history.length - 24));
    await session.textChannel.send(`**Coderたん**\n${reply.slice(0, 1900)}`);
    await playTts(session, reply);
  } catch (error) {
    console.error("[talk] request failed:", error?.stack || error);
    await session.textChannel.send(`処理に失敗しました: \`${error.message || error}\``).catch(() => {});
  } finally {
    session.busy = false;
  }
}

async function completeTalkSession(session, member) {
  if (session.busy) {
    await session.textChannel.send("前の依頼を処理中です。完了してからもう一度 `完成` を送ってください。");
    return;
  }
  session.busy = true;
  await session.textChannel.send("完成したよ！こんな感じ？ファイルとプレビューをまとめるね。");
  await playTts(session, "完成したよ。ファイルとプレビューをまとめるね。");
  try {
      const project = await generateProject(session, "Create the final completed project from this talk-coding session.", member.id);
    const attachments = await buildProjectAttachments(project);
    const links = await uploadAttachmentsToDrive(session.ownerId, attachments).catch((error) => {
      console.error("Drive upload failed:", error.message);
      return [];
    });
    const driveText = links.length ? `\nGoogle Drive: 保存しました。\n${links.slice(0, 5).join("\n")}` : "";
    const brainText = formatBrainMeeting(project);
    const usageLine = aiUsageLine(project);
    await session.textChannel.send({
      content: `**${project.title}**\n${project.summary}${brainText}\n\n${project.files.length} files generated with ${PUTER_CHAT_MODEL}.${usageLine ? `\n${usageLine}` : ""}${driveText}`.slice(0, 2000),
      files: attachments,
    });
  } catch (error) {
    await session.textChannel.send(`完成ファイルの生成に失敗しました: \`${error.message}\``);
  } finally {
    session.busy = false;
  }
}

async function stopTalkSession(guildId) {
  const session = sessions.get(guildId);
  if (!session) return false;
  if (session.scanTimer) clearInterval(session.scanTimer);
  if (session.receiverDiagTimer) clearInterval(session.receiverDiagTimer);
  for (const stream of session.subscriptions.values()) stream.destroy?.();
  session.connection.destroy();
  sessions.delete(guildId);
  return true;
}

function addLanguageOption(command, name = "programming_language", description = "プログラミング言語や技術スタック") {
  return command.addStringOption((option) =>
    option
      .setName(name)
      .setDescription(description)
      .setRequired(true)
      .addChoices(...LANGUAGE_CHOICES.map((value) => ({ name: value, value })))
  );
}

function addModelOption(command, name = "model", description = "使用するAIモデル") {
  return command.addStringOption((option) =>
    option
      .setName(name)
      .setDescription(description)
      .setRequired(false)
      .addChoices(...MODEL_CHOICES.map((value) => ({ name: value, value })))
  );
}

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  checkVoiceReceiveRuntime();
  startDriveOAuthServer();
  const commands = [
    addModelOption(
      addLanguageOption(
        new SlashCommandBuilder()
          .setName("coder")
          .setDescription("AIでコードを生成してzipとプレビューを送信します")
          .addStringOption((option) => option.setName("content").setDescription("作ってほしい内容").setRequired(true))
      )
    ),
    addModelOption(
      addLanguageOption(
        new SlashCommandBuilder()
          .setName("review")
          .setDescription("コードレビューを行います")
          .addStringOption((option) => option.setName("code").setDescription("レビューしたいコード").setRequired(true))
      )
    ).addAttachmentOption((option) => option.setName("file").setDescription("追加で読むテキストファイル").setRequired(false)),
    addModelOption(
      addLanguageOption(
        new SlashCommandBuilder()
          .setName("debug")
          .setDescription("エラーやログから原因を解析します")
          .addStringOption((option) => option.setName("error").setDescription("エラー、ログ、スタックトレース").setRequired(true))
      )
    )
      .addStringOption((option) => option.setName("code").setDescription("関連コード").setRequired(false))
      .addAttachmentOption((option) => option.setName("file").setDescription("追加で読むテキストファイル").setRequired(false)),
    new SlashCommandBuilder()
      .setName("generate")
      .setDescription("機能単位でコードを生成します")
      .addSubcommand((sub) =>
        addModelOption(
          addLanguageOption(
            sub
              .setName("feature")
              .setDescription("既知の文脈に合わせて機能を生成します")
              .addStringOption((option) => option.setName("feature").setDescription("追加したい機能").setRequired(true))
          )
        )
      ),
    new SlashCommandBuilder()
      .setName("talk")
      .setDescription("VCトーク管理")
      .addSubcommand((sub) =>
        sub
          .setName("join")
          .setDescription("CoderたんをVCに参加させます")
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("参加するVC。未指定なら自分がいるVC")
              .setRequired(false)
              .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
          )
      )
      .addSubcommand((sub) => sub.setName("leave").setDescription("CoderたんをVCから退出させます"))
      .addSubcommand((sub) =>
        sub
          .setName("mode")
          .setDescription("VCトークのモードを切り替えます")
          .addStringOption((option) =>
            option
              .setName("mode")
              .setDescription("切り替えるモード")
              .setRequired(true)
              .addChoices({ name: "雑談モード", value: "chat" }, { name: "コーディングモード", value: "coding" })
          )
      ),
    new SlashCommandBuilder()
      .setName("video")
      .setDescription("Generate a video")
      .addStringOption((option) => option.setName("prompt").setDescription("Video prompt").setRequired(true))
      .addStringOption((option) =>
        option
          .setName("quality")
          .setDescription("Video quality")
          .setRequired(false)
          .addChoices(...Object.keys(VIDEO_QUALITY_SIZES).map((value) => ({ name: value, value })))
      )
      .addIntegerOption((option) =>
        option
          .setName("duration")
          .setDescription("Video duration seconds, max 5")
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(MAX_VIDEO_DURATION_SECONDS)
      ),
    new SlashCommandBuilder()
      .setName("support")
      .setDescription("DisCoderの開発・運用費支援について表示します"),
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("DisCoderのコマンド、VC、OpenRouter連携の使い方を表示します"),
    new SlashCommandBuilder()
      .setName("puter")
      .setDescription("Puterユーザー連携")
      .addSubcommand((sub) => sub.setName("connect").setDescription("自分のPuterアカウントをこのbotに連携します"))
      .addSubcommand((sub) => sub.setName("status").setDescription("Puter連携状態を確認します"))
      .addSubcommand((sub) => sub.setName("disconnect").setDescription("Puter連携を解除します")),
    new SlashCommandBuilder()
      .setName("openrouter")
      .setDescription("OpenRouter user fallback settings")
      .addSubcommand((sub) =>
        sub
          .setName("connect")
          .setDescription("Save your own OpenRouter API key")
          .addStringOption((option) => option.setName("api_key").setDescription("OpenRouter API key").setRequired(true))
          .addStringOption((option) => option.setName("model").setDescription("Default OpenRouter text model").setRequired(false))
          .addStringOption((option) => option.setName("image_model").setDescription("Default OpenRouter image model").setRequired(false))
          .addStringOption((option) => option.setName("vision_model").setDescription("Default OpenRouter vision/OCR model").setRequired(false))
          .addStringOption((option) => option.setName("video_model").setDescription("Default OpenRouter video model").setRequired(false))
          .addStringOption((option) => option.setName("video_size").setDescription("Default video size, e.g. 1280x720 or 720x1280").setRequired(false))
      )
      .addSubcommand((sub) =>
        sub
          .setName("media")
          .setDescription("Set image/video/vision provider routing")
          .addStringOption((option) =>
            option.setName("kind").setDescription("Media kind").setRequired(true).addChoices(
              { name: "image", value: "image" },
              { name: "vision", value: "vision" },
              { name: "video", value: "video" }
            )
          )
          .addStringOption((option) => option.setName("provider").setDescription("Provider route").setRequired(true).addChoices(...MEDIA_PROVIDER_CHOICES))
          .addStringOption((option) => option.setName("model").setDescription("OpenRouter model for this media kind").setRequired(false))
          .addStringOption((option) => option.setName("size").setDescription("Video size, e.g. 1280x720, 1920x1080, 720x1280").setRequired(false))
      )
      .addSubcommand((sub) =>
        sub
          .setName("fallback")
          .setDescription("Enable or disable Puter credit fallback")
          .addBooleanOption((option) => option.setName("enabled").setDescription("Fallback enabled").setRequired(true))
      )
      .addSubcommand((sub) => sub.setName("status").setDescription("Show OpenRouter fallback settings"))
      .addSubcommand((sub) => sub.setName("disconnect").setDescription("Delete your OpenRouter API key")),
    new SlashCommandBuilder()
      .setName("drive")
      .setDescription("Google Drive連携")
      .addSubcommand((sub) => sub.setName("connect").setDescription("Google Drive連携URLを発行します"))
      .addSubcommand((sub) => sub.setName("status").setDescription("Google Drive連携状態を確認します"))
      .addSubcommand((sub) => sub.setName("disconnect").setDescription("Google Drive連携を解除します")),
  ].map((command) => command.toJSON());
  if (process.env.DISCORD_GUILD_ID) {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    await guild.commands.set(commands);
    console.log(`Registered ${commands.length} guild slash commands for ${guild.name}.`);
  } else {
    await client.application.commands.set(commands);
    console.log(`Registered ${commands.length} global slash commands.`);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    cleanupPublishResults();
    cleanupPendingVideoRequests();
    if (interaction.customId.startsWith("video:")) {
      const [, action, requestId] = interaction.customId.split(":");
      const request = pendingVideoRequests.get(requestId);
      if (!request) {
        await interaction.reply({ content: "動画生成リクエストが見つからないか期限切れです。", flags: 64 });
        return;
      }
      if (request.userId !== interaction.user.id) {
        await interaction.reply({ content: "この動画生成を実行できるのは、コマンドを実行した本人だけです。", flags: 64 });
        return;
      }
      if (action === "cancel") {
        pendingVideoRequests.delete(requestId);
        await interaction.update({ content: "キャンセルしました。", components: [] });
        return;
      }
      if (action !== "confirm") return;
      pendingVideoRequests.delete(requestId);
      await interaction.update({
        content: `動画生成を開始しました。\nquality: ${request.quality}\nsize: ${request.size}\nduration: ${request.duration}s`,
        components: [],
      });
      try {
        const channel = await resolveInteractionTextChannel(interaction, request.channelId);
        await sendDirectVideoResultForUserWithOptions(channel, request.prompt, interaction.user.id, {
          size: request.size,
          duration: request.duration,
        });
        await interaction.followUp({ content: "動画生成が完了しました。結果はこのチャンネルに投稿しました。", flags: 64 });
      } catch (error) {
        console.error("[slash video confirm] failed:", error?.stack || error);
        await interaction.followUp({ content: `動画生成に失敗しました: \`${error.message || error}\``, flags: 64 });
      }
      return;
    }
    if (!interaction.customId.startsWith("publish:")) return;
    const publishId = interaction.customId.slice("publish:".length);
    const result = publishResults.get(publishId);
    if (!result) {
      await interaction.reply({ content: "公開できる結果が見つかりません。もう一度生成してください。", flags: 64 });
      return;
    }
    if (result.ownerId !== interaction.user.id) {
      await interaction.reply({ content: "生成した本人だけが公開できます。", flags: 64 });
      return;
    }
    if (result.channelId !== interaction.channelId) {
      await interaction.reply({ content: "生成したチャンネルで公開してください。", flags: 64 });
      return;
    }
    await interaction.channel.send({
      content: result.content,
      files: makeAttachmentBuilders(result.attachments),
    });
    publishResults.delete(publishId);
    await interaction.update({ content: `${result.content}\n\n公開しました。`, components: [] });
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "support") {
    await interaction.reply({ content: SUPPORT_MESSAGE, flags: 64 });
    return;
  }
  if (interaction.commandName === "help") {
    await interaction.reply({ content: HELP_MESSAGE, flags: 64 });
    return;
  }
  if (interaction.commandName === "coder") {
    await interaction.deferReply({ flags: 64 });
    try {
      const content = interaction.options.getString("content", true);
      const programmingLanguage = interaction.options.getString("programming_language", true);
      const model = interaction.options.getString("model") || DEFAULT_CODE_MODEL;
      await updateInteractionProgress(interaction, `コードを生成しています... モデル: \`${model}\``);
      const project = await generateProjectForCommand(content, programmingLanguage, model, buildMemoryContext(interaction), interaction.user.id);
      await sendProjectResult(interaction, project, model, programmingLanguage);
      rememberCommand(interaction, `coder: ${project.title}. Request: ${content}. Language: ${programmingLanguage}. Files: ${project.files.length}.`);
    } catch (error) {
      logCommandError("coder", error);
      await interaction.editReply(`コード生成に失敗しました: \`${error.message}\``);
    }
    return;
  }
  if (interaction.commandName === "review") {
    await interaction.deferReply({ flags: 64 });
    try {
      const code = interaction.options.getString("code", true);
      const programmingLanguage = interaction.options.getString("programming_language", true);
      const model = interaction.options.getString("model") || DEFAULT_CODE_MODEL;
      await updateInteractionProgress(interaction, `レビューしています... モデル: \`${model}\``);
      const fileText = await attachmentToText(interaction.options.getAttachment("file"));
      const fullCode = `${code}\n\n${fileText}`.trim();
      const response = await generateTextResponse(buildReviewPrompt(fullCode, programmingLanguage, buildMemoryContext(interaction)), model, interaction.user.id);
      await interaction.editReply(`**Code Review**\n${response}\n\nモデル: \`${model}\``.slice(0, 2000));
      rememberCommand(interaction, `review: ${programmingLanguage}. Response: ${response.slice(0, 500)}`);
    } catch (error) {
      logCommandError("review", error);
      await interaction.editReply(`レビューに失敗しました: \`${error.message}\``);
    }
    return;
  }
  if (interaction.commandName === "debug") {
    await interaction.deferReply({ flags: 64 });
    try {
      const errorText = interaction.options.getString("error", true);
      const code = interaction.options.getString("code") || "";
      const programmingLanguage = interaction.options.getString("programming_language", true);
      const model = interaction.options.getString("model") || DEFAULT_CODE_MODEL;
      await updateInteractionProgress(interaction, `解析しています... モデル: \`${model}\``);
      const fileText = await attachmentToText(interaction.options.getAttachment("file"));
      const fullCode = `${code}\n\n${fileText}`.trim();
      const response = await generateTextResponse(buildDebugPrompt(errorText, fullCode || null, programmingLanguage, buildMemoryContext(interaction)), model, interaction.user.id);
      await interaction.editReply(`**Debug Analysis**\n${response}\n\nモデル: \`${model}\``.slice(0, 2000));
      rememberCommand(interaction, `debug: ${programmingLanguage}. Error: ${errorText.slice(0, 250)}. Response: ${response.slice(0, 500)}`);
    } catch (error) {
      logCommandError("debug", error);
      await interaction.editReply(`解析に失敗しました: \`${error.message}\``);
    }
    return;
  }
  if (interaction.commandName === "generate") {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "feature") {
      await interaction.deferReply({ flags: 64 });
      try {
        const feature = interaction.options.getString("feature", true);
        const programmingLanguage = interaction.options.getString("programming_language", true);
        const model = interaction.options.getString("model") || DEFAULT_CODE_MODEL;
        await updateInteractionProgress(interaction, `機能を生成しています... モデル: \`${model}\``);
        const request = `Implement this as a focused feature addition for the known project. Reuse project context when relevant and avoid unrelated rewrites.\n\n${feature}`;
        const project = await generateProjectForCommand(request, programmingLanguage, model, buildMemoryContext(interaction), interaction.user.id);
        await sendProjectResult(interaction, project, model, programmingLanguage);
        rememberCommand(interaction, `generate feature: ${project.title}. Request: ${feature}. Language: ${programmingLanguage}. Files: ${project.files.length}.`);
      } catch (error) {
        logCommandError("generate feature", error);
        await interaction.editReply(`機能生成に失敗しました: \`${error.message}\``);
      }
      return;
    }
  }
  if (interaction.commandName === "drive") {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "connect") {
      if (!googleOAuthConfigured()) {
        await interaction.reply({ content: "Google Drive連携が未設定です。GOOGLE_CLIENT_ID と GOOGLE_CLIENT_SECRET を設定してください。", flags: 64 });
        return;
      }
      const state = crypto.randomBytes(24).toString("hex");
      OAUTH_STATES.set(state, interaction.user.id);
      const url = createOAuthClient().generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: DRIVE_SCOPES,
        state,
      });
      await interaction.reply({ content: `以下のURLからGoogle Drive連携を許可してください。\n${url}`, flags: 64 });
      return;
    }
    if (subcommand === "status") {
      const connected = Boolean(loadDriveTokens()[interaction.user.id]);
      await interaction.reply({ content: connected ? `Google Drive連携済みです。保存先: ${googleDriveFolderName()}` : "未連携です。`/drive connect` で連携できます。", flags: 64 });
      return;
    }
    if (subcommand === "disconnect") {
      const tokens = loadDriveTokens();
      delete tokens[interaction.user.id];
      saveDriveTokens(tokens);
      await interaction.reply({ content: "Google Drive連携を解除しました。", flags: 64 });
      return;
    }
  }
  if (interaction.commandName === "video") {
    try {
      const prompt = interaction.options.getString("prompt", true);
      const quality = interaction.options.getString("quality") || DEFAULT_VIDEO_QUALITY;
      const duration = normalizeVideoDurationSeconds(interaction.options.getInteger("duration") || DEFAULT_VIDEO_DURATION_SECONDS);
      const size = videoQualityToSize(quality);
      const requestId = crypto.randomBytes(12).toString("hex");
      pendingVideoRequests.set(requestId, {
        userId: interaction.user.id,
        channelId: interaction.channelId,
        prompt,
        quality: size.quality,
        size: size.size,
        duration,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`video:confirm:${requestId}`).setLabel("生成する").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`video:cancel:${requestId}`).setLabel("キャンセル").setStyle(ButtonStyle.Secondary)
      );
      await interaction.reply({
        content:
          "\u26a0\ufe0f \u52d5\u753b\u751f\u6210\u306f\u9ad8\u30b3\u30b9\u30c8\u3067\u3059\u3002\n" +
          "OpenRouter\u3067\u306f480p\u4ee5\u4e0a\u304c\u6700\u4f4e\u89e3\u50cf\u5ea6\u3067\u3059\u3002\n" +
          "\u9ad8\u753b\u8cea\u30fb\u9577\u6642\u9593\u307b\u3069\u6599\u91d1\u304c\u5927\u304d\u304f\u5897\u3048\u307e\u3059\u3002\n" +
          SUPPORT_NOTICE +
          "\n\n" +
          `quality: ${size.quality}\n` +
          `size: ${size.size}\n` +
          `duration: ${duration}s\n` +
          "\u7d9a\u884c\u3057\u307e\u3059\u304b\uff1f",
        components: [row],
        flags: 64,
      });
    } catch (error) {
      console.error("[slash video] failed:", error?.stack || error);
      await interaction.reply({ content: `動画生成リクエストを受け付けられませんでした: \`${error.message || error}\``, flags: 64 });
    }
    return;
  }
  if (interaction.commandName === "puter") {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "connect") {
      const baseUrl = publicBaseUrl();
      if (!baseUrl) {
        await interaction.reply({ content: "Puter連携には公開URLが必要です。`GOOGLE_PUBLIC_BASE_URL` などで ngrok のURLを設定してください。", flags: 64 });
        return;
      }
      const state = crypto.randomBytes(24).toString("hex");
      PUTER_AUTH_STATES.set(state, interaction.user.id);
      const redirectUrl = `${baseUrl}/puter-auth?state=${state}`;
      const url = `https://puter.com/?action=authme&redirectURL=${encodeURIComponent(redirectUrl)}`;
      await interaction.reply({
        content: `以下のURLからPuterにログインしてください。完了後、このDiscordユーザーのPuterトークンとして保存します。\n${url}`,
        flags: 64,
      });
      return;
    }
    if (subcommand === "status") {
      await interaction.reply({
        content: hasPuterUserToken(interaction.user.id) ? "Puter連携済みです。このユーザーのPuter残高でAI生成します。" : "Puter未連携です。`/puter connect` で連携できます。",
        flags: 64,
      });
      return;
    }
    if (subcommand === "disconnect") {
      deletePuterUserToken(interaction.user.id);
      await interaction.reply({ content: "Puter連携を解除しました。", flags: 64 });
      return;
    }
  }
  if (interaction.commandName === "openrouter") {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "connect") {
      const apiKey = interaction.options.getString("api_key", true).trim();
      const model = (interaction.options.getString("model") || OPENROUTER_DEFAULT_MODEL).trim();
      const imageModel = (interaction.options.getString("image_model") || OPENROUTER_IMAGE_MODEL).trim();
      const visionModel = (interaction.options.getString("vision_model") || OPENROUTER_VISION_MODEL).trim();
      const videoModel = (interaction.options.getString("video_model") || OPENROUTER_VIDEO_MODEL).trim();
      const videoSize = normalizeVideoSize(interaction.options.getString("video_size") || OPENROUTER_VIDEO_SIZE).size;
      saveOpenRouterConfig(interaction.user.id, { apiKey, model, imageModel, visionModel, videoModel, videoSize, fallbackEnabled: true });
      await interaction.reply({
        content: `OpenRouterを連携しました。Puter上限時はユーザー個別のOpenRouterキーへフォールバックします。\nText: \`${model}\`\nImage: \`${imageModel}\`\nVision: \`${visionModel}\`\nVideo: \`${videoModel}\`\n円換算レート: 1 USD = ${OPENROUTER_USD_JPY}円`,
        flags: 64,
      });
      return;
    }
    if (subcommand === "media") {
      const config = loadOpenRouterConfig(interaction.user.id);
      if (!config?.apiKey) {
        await interaction.reply({ content: "OpenRouter未連携です。`/openrouter connect` で自分のAPIキーを登録してください。", flags: 64 });
        return;
      }
      const kind = interaction.options.getString("kind", true);
      const provider = interaction.options.getString("provider", true);
      const model = interaction.options.getString("model");
      const size = interaction.options.getString("size");
      const next = { ...openRouterMediaConfig(interaction.user.id), apiKey: config.apiKey };
      next[`${kind}Provider`] = provider;
      if (model) next[`${kind}Model`] = model.trim();
      if (kind === "video" && size) next.videoSize = normalizeVideoSize(size).size;
      saveOpenRouterConfig(interaction.user.id, next);
      await interaction.reply({
        content: `${kind} の経路を \`${provider}\` にしました。${next[`${kind}Model`] ? `OpenRouter model: \`${next[`${kind}Model`]}\`` : ""}`,
        flags: 64,
      });
      return;
    }
    if (subcommand === "fallback") {
      const enabled = interaction.options.getBoolean("enabled", true);
      const config = loadOpenRouterConfig(interaction.user.id);
      if (!config?.apiKey) {
        await interaction.reply({ content: "OpenRouter未連携です。`/openrouter connect` で自分のAPIキーを登録してください。", flags: 64 });
        return;
      }
      saveOpenRouterConfig(interaction.user.id, { ...config, fallbackEnabled: enabled });
      await interaction.reply({ content: `OpenRouterフォールバックを${enabled ? "有効" : "無効"}にしました。`, flags: 64 });
      return;
    }
    if (subcommand === "status") {
      const config = loadOpenRouterConfig(interaction.user.id);
      await interaction.reply({
        content: config?.apiKey
          ? `OpenRouter連携済みです。\nText: \`${config.model || OPENROUTER_DEFAULT_MODEL}\`\nImage: \`${config.imageModel || OPENROUTER_IMAGE_MODEL}\` (${config.imageProvider || "auto"})\nVision: \`${config.visionModel || OPENROUTER_VISION_MODEL}\` (${config.visionProvider || "auto"})\nVideo: \`${config.videoModel || OPENROUTER_VIDEO_MODEL}\` (${config.videoProvider || "auto"})\nPuter上限時フォールバック: ${config.fallbackEnabled !== false ? "有効" : "無効"}\n円換算レート: 1 USD = ${OPENROUTER_USD_JPY}円`
          : "OpenRouter未連携です。`/openrouter connect` で自分のAPIキーを登録してください。",
        flags: 64,
      });
      return;
    }
    if (subcommand === "disconnect") {
      deleteOpenRouterConfig(interaction.user.id);
      await interaction.reply({ content: "OpenRouter連携を解除しました。", flags: 64 });
      return;
    }
  }
  if (interaction.commandName !== "talk") return;
  const talkSubcommand = interaction.options.getSubcommand();
  if (talkSubcommand === "join") {
    await interaction.deferReply();
    const voiceChannel = findInteractionVoiceChannel(interaction);
    if (!voiceChannel) {
      await interaction.editReply("参加するVCを指定するか、先にVCへ入ってから `/talk join` を実行してください。");
      return;
    }
    await startTalkSessionFromInteraction(interaction, voiceChannel);
    return;
  }
  if (talkSubcommand === "mode") {
    const session = sessions.get(interaction.guildId);
    if (!session) {
      await interaction.reply({ content: "`/talk join` でVCセッションを開始してから切り替えてください。", flags: 64 });
      return;
    }
    if (session.ownerId !== interaction.user.id) {
      await interaction.reply({ content: "開始した人だけがモードを切り替えできます。", flags: 64 });
      return;
    }
    session.mode = interaction.options.getString("mode", true);
    await interaction.reply(`現在は${session.mode === "chat" ? "雑談モード" : "コーディングモード"}です。`);
    return;
  }
  if (talkSubcommand === "leave") {
    const session = sessions.get(interaction.guildId);
    if (session && session.ownerId !== interaction.user.id) {
      await interaction.reply({ content: "開始した人だけが退出できます。", flags: 64 });
      return;
    }
    await stopTalkSession(interaction.guildId);
    await interaction.reply({ content: "CoderたんをVCから退出させました。", flags: 64 });
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  const mentioned = isBotMentioned(message);
  const content = stripBotMention(message.content);
  const session = sessions.get(message.guild.id);

  if (session && message.channel.id === session.textChannelId && content && isVideoRequest(content)) {
    console.log(`[talk] session txt2vid request guild=${message.guild.id} channel=${message.channel.id} mentioned=${mentioned}: ${content}`);
    if (session.busy) {
      await message.reply("前の依頼を処理中です。少し待ってね。");
      return;
    }
    session.busy = true;
    await message.reply(`動画生成リクエストを受け付けました。生成中...\n\n${SUPPORT_NOTICE}`);
    try {
      await sendDirectVideoResultForUser(message.channel, content, message.author.id);
      session.history.push({ role: "user", content: `${message.member?.displayName || message.author.username}: ${content}` });
      session.history.push({ role: "assistant", content: "動画を生成して投稿しました。" });
      session.history.splice(0, Math.max(0, session.history.length - 24));
    } catch (error) {
      console.error("[talk] session txt2vid failed:", error?.stack || error);
      await message.channel.send(`動画生成に失敗しました: \`${error.message || error}\``).catch(() => {});
    } finally {
      session.busy = false;
    }
    return;
  }

  if (mentioned && content && isVideoRequest(content)) {
    console.log(`[talk] direct txt2vid request guild=${message.guild.id} channel=${message.channel.id}: ${content}`);
    if (session?.busy) {
      await message.reply("前の依頼を処理中です。少し待ってね。");
      return;
    }
    if (session) session.busy = true;
    await message.reply(`動画生成リクエストを受け付けました。生成中...\n\n${SUPPORT_NOTICE}`);
    try {
      await sendDirectVideoResultForUser(message.channel, content, message.author.id);
      if (session) {
        session.history.push({ role: "user", content: `${message.member?.displayName || message.author.username}: ${content}` });
        session.history.push({ role: "assistant", content: "動画を生成して投稿しました。" });
        session.history.splice(0, Math.max(0, session.history.length - 24));
      }
    } catch (error) {
      console.error("[talk] direct txt2vid failed:", error?.stack || error);
      await message.channel.send(`動画生成に失敗しました: \`${error.message || error}\``).catch(() => {});
    } finally {
      if (session) session.busy = false;
    }
    return;
  }

  if (mentioned && isLeaveRequest(content)) {
    if (session && session.ownerId !== message.author.id) {
      await message.reply("開始した人だけが退出できます。");
      return;
    }
    await stopTalkSession(message.guild.id);
    await message.reply("CoderたんをVCから退出させました。");
    return;
  }

  if (session && message.channel.id === session.textChannelId && mentioned) {
    if (!content) {
      await message.reply("VCセッション中です。メンションの後ろに内容を書いてください。");
      return;
    }
    if (DEBUG_STT) {
      console.log(`[talk] mention content guild=${message.guild.id} channel=${message.channel.id}: ${content}`);
    }
    const member = await message.guild.members.fetch(message.author.id);
    await handleTalkText(session, member, content, false, { attachments: message.attachments });
    return;
  }

  if (mentioned) {
    const voiceChannel = findVoiceChannel(message);
    if (voiceChannel) {
      const startedSession = await startTalkSession(message, voiceChannel);
      if (startedSession && content) {
        const member = await message.guild.members.fetch(message.author.id);
        await handleTalkText(startedSession, member, content, false, { attachments: message.attachments });
      }
      return;
    }
  }
});

client.login(DISCORD_TOKEN);
