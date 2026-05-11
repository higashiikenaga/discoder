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
const PUTER_STT_MODEL = process.env.PUTER_STT_MODEL || "gpt-4o-mini-transcribe";
const PUTER_STT_MODELS = String(process.env.PUTER_STT_MODELS || PUTER_STT_MODEL)
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
const PUTER_TTS_PROVIDER = process.env.PUTER_TTS_PROVIDER || "openai";
const PUTER_TTS_MODEL = process.env.PUTER_TTS_MODEL || "gpt-4o-mini-tts";
const PUTER_TTS_VOICE = process.env.PUTER_TTS_VOICE || "nova";
const PUTER_AI_TIMEOUT_MS = Number(process.env.PUTER_AI_TIMEOUT_MS || 90000);
const STT_LANGUAGE = process.env.TALK_CODING_STT_LANGUAGE_CODE || "ja";
const DEBUG_STT = isTruthy(process.env.TALK_CODING_DEBUG_STT);
const SAVE_STT_AUDIO = isTruthy(process.env.TALK_CODING_SAVE_STT_AUDIO);
const STT_END_SILENCE_MS = Number(process.env.TALK_CODING_STT_END_SILENCE_MS || 800);
const STT_SCAN_SUBSCRIBE = isTruthy(process.env.TALK_CODING_STT_SCAN_SUBSCRIBE);
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
let driveOAuthServerStarted = false;
const commandMemory = new Map();
const publishResults = new Map();
const MODEL_CHOICES = [
  "gemini-3-flash-preview",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gpt-5-nano",
];
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
  /(?:コー|こー|こう)\s*(?:ダー|だー|だ)\s*(?:たん|さん|ちゃん)?/i,
  /コード\s*(?:たん|さん|ちゃん)?/i,
  /こーど\s*(?:たん|さん|ちゃん)?/i,
  /coder\s*(?:tan|たん|さん|ちゃん)?/i,
];

if (!DISCORD_TOKEN) throw new Error("DISCORD_TOKEN is not set.");
let puterPromise = null;
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

async function getPuter() {
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

function loadPuterToken() {
  try {
    const data = JSON.parse(fs.readFileSync(NODE_PUTER_TOKEN_PATH, "utf8"));
    return data.authToken || null;
  } catch {
    return null;
  }
}

function savePuterToken(authToken) {
  fs.writeFileSync(NODE_PUTER_TOKEN_PATH, JSON.stringify({ authToken }, null, 2), "utf8");
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
    files,
  };
}

function buildProjectPrompt(request, history) {
  return `
You are a senior software engineer generating a complete runnable coding result.

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
  "files": [{"path": "relative/file/path.ext", "content": "full file content"}]
}

Rules:
- Generate complete files, not fragments.
- Keep paths relative. Do not use absolute paths or .. segments.
- If a web UI is generated, include a directly previewable HTML file.
- Include README.md when setup or run steps are useful.
`.trim();
}

async function generateProject(session, request) {
  const response = await puterChat(buildProjectPrompt(request, session.history), PUTER_CHAT_MODEL, "talk final project");
  return validateProject(extractJson(extractText(response)));
}

function buildCommandProjectPrompt(request, programmingLanguage, projectContext) {
  return `
You are a senior software engineer generating a complete runnable coding result.

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
  "files": [{"path": "relative/file/path.ext", "content": "full file content"}]
}

Rules:
- Generate complete files, not fragments.
- Keep paths relative. Do not use absolute paths or .. segments.
- If a web UI is generated, include a directly previewable HTML file.
- Include README.md when setup or run steps are useful.
- Prefer a focused answer that matches the requested language/framework.
`.trim();
}

async function generateProjectForCommand(request, programmingLanguage, model, projectContext) {
  const selectedModel = model || DEFAULT_CODE_MODEL;
  const response = await puterChat(buildCommandProjectPrompt(request, programmingLanguage, projectContext), selectedModel, "project generation");
  return validateProject(extractJson(extractText(response)));
}

async function generateTextResponse(prompt, model) {
  const selectedModel = model || DEFAULT_CODE_MODEL;
  const response = await puterChat(prompt, selectedModel, "text response");
  return extractText(response).trim() || "回答を生成できませんでした。";
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

async function puterChat(prompt, model, label) {
  const puter = await getPuter();
  const startedAt = Date.now();
  console.log(`[AI] ${label} start model=${model}`);
  try {
    const response = await withTimeout(puter.ai.chat(prompt, { model }), `puter.ai.chat ${model}`);
    console.log(`[AI] ${label} done ${Date.now() - startedAt}ms`);
    return response;
  } catch (error) {
    console.error(`[AI] ${label} failed after ${Date.now() - startedAt}ms:`, error?.stack || error);
    throw error;
  }
}

function buildReviewPrompt(code, programmingLanguage, projectContext) {
  return `
You are a strict senior code reviewer.

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
Keep the response concise enough for Discord.
`.trim();
}

function buildDebugPrompt(errorText, code, programmingLanguage, projectContext) {
  const codeBlock = code ? `\nRelated code:\n\`\`\`${programmingLanguage}\n${code}\n\`\`\`` : "";
  return `
You are a debugging assistant for software engineers.

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
  const publicContent =
    `**${project.title}**\n${project.summary}\n\n${project.files.length} files generated.\n言語/技術: \`${programmingLanguage}\`\nモデル: \`${model}\`${driveText}`.slice(
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
    content: `${publicContent}\n\n引用/出典ファイル: \`ASSET_SOURCES.md\`\nこの結果をチャンネルに出す場合は「公開」を押してください。`.slice(0, 2000),
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
  return output.replace(/^[、。!！?？:：\s-]+/, "").trim();
}

function isLeaveRequest(text) {
  return /\b(leave|disconnect|stop)\b|終了|退出|切断/i.test(text);
}

function isCompleteRequest(text) {
  return text.includes("完成");
}

function findVoiceChannel(message) {
  const mentioned = message.mentions.channels.find((channel) => channel.isVoiceBased());
  if (mentioned) return mentioned;
  return message.member?.voice?.channel || null;
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
  if (!googleOAuthConfigured()) return;
  if (driveOAuthServerStarted) return;
  driveOAuthServerStarted = true;
  const url = new URL(googleRedirectUri());
  const port = Number(process.env.GOOGLE_OAUTH_PORT || url.port || 8080);
  const host = process.env.GOOGLE_OAUTH_HOST || "::";
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    if (requestUrl.pathname !== "/oauth2callback") {
      res.writeHead(404);
      res.end("Not found");
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
  server.listen(port, host, () => console.log(`Google OAuth callback listening on ${host}:${port}`));
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

function pcmStereoToWavDataUrl(pcm) {
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
  return `data:audio/wav;base64,${result.stdout.toString("base64")}`;
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

async function generateReply(session, userText) {
  const puter = await getPuter();
  const messages = [
    {
      role: "system",
      content:
        "You are Coder-tan, a concise Japanese Discord VC coding assistant. Answer in Japanese. Generate code when useful. Keep replies short for TTS.",
    },
    ...session.history.slice(-16),
    { role: "user", content: userText },
  ];
  const response = await puter.ai.chat(messages, { model: PUTER_CHAT_MODEL });
  return extractText(response).trim() || "うまく返答を作れなかったよ。";
}

async function synthesizeTts(text) {
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
  let reconnecting = false;
  connection.on("stateChange", async (_oldState, newState) => {
    if (newState.status !== VoiceConnectionStatus.Disconnected || reconnecting) return;
    if (connection.state.status === VoiceConnectionStatus.Destroyed) return;
    reconnecting = true;
    try {
      const movedOrKicked =
        newState.reason === VoiceConnectionDisconnectReason.WebSocketClose && newState.closeCode === 4014;
      if (movedOrKicked) {
        try {
          await entersState(connection, VoiceConnectionStatus.Signalling, 5000);
        } catch {
          connection.rejoin();
        }
      } else {
        connection.rejoin();
      }
      await entersState(connection, VoiceConnectionStatus.Ready, 30000);
      console.log(`[voice] reconnected guild=${guildId}`);
    } catch (error) {
      console.error(`[voice] reconnect failed guild=${guildId}:`, error?.stack || error);
    } finally {
      reconnecting = false;
    }
  });
}

function shouldReceiveUser(session, userId) {
  if (VOICE_RECEIVE_USER_IDS.size === 0) return true;
  if (VOICE_RECEIVE_USER_IDS.has(userId)) return true;
  if (DEBUG_STT) session.textChannel.send(`[STT] ignored ${userId}; not in TALK_CODING_RECEIVE_USER_IDS`).catch(() => {});
  return false;
}

function createPcmReceiveStream(connection, userId, endBehavior = { behavior: EndBehaviorType.Manual }) {
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
      return;
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
    decryptionFailureTolerance: 24,
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
    return;
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
  connection.receiver.speaking.on("end", (userId) => finishVoiceSubscription(session, userId, "speaking end"));
  connection.receiver.speaking.on("start", (userId) => {
    if (DEBUG_STT) session.textChannel.send(`[STT] speaking start ${userId}`).catch(() => {});
  });
  connection.receiver.speaking.on("end", (userId) => {
    if (DEBUG_STT) session.textChannel.send(`[STT] speaking end ${userId}`).catch(() => {});
  });
  attachVoiceReceiveDiagnostics(session);

  await reportVoiceDiagnostics(session, voiceChannel);
  await waitMessage.edit(`Coderたんが ${voiceChannel} に参加しました。VCで「コーダーたん！」と呼ぶか、このチャンネルでメンションしてください。`);
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
    timeout: setTimeout(() => finishVoiceSubscription(session, userId, "recording window"), 3500),
    destroy() {
      clearTimeout(this.timeout);
      this.opus.destroy?.();
      this.decoder.destroy?.();
    },
  };
  session.subscriptions.set(userId, record);
  if (DEBUG_STT) session.textChannel.send(`[STT] subscribed ${userId} (${reason})`).catch(() => {});

  decoder.on("data", (chunk) => {
    record.chunks.push(chunk);
    record.bytes += chunk.length;
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
  clearTimeout(record.timeout);
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
    await session.textChannel.send(`[STT] saved debug wav: ${file}`);
  }

  if (DEBUG_STT) await session.textChannel.send("[STT] sending audio to Puter STT...");
  const transcript = await transcribePcm(pcm);
  const text = transcript.text;
  if (!text) {
    if (DEBUG_STT) {
      await session.textChannel
        .send(`[STT] transcript empty model=${transcript.model || "unknown"} raw=${summarizeValue(transcript.raw)}`.slice(0, 1900));
    }
    return;
  }
  const member = await session.textChannel.guild.members.fetch(userId).catch(() => null);
  if (!member || member.voice.channelId !== session.voiceChannelId) return;
  if (DEBUG_STT) await session.textChannel.send(`[STT] ${member.displayName}: ${text}`);
  await handleTalkText(session, member, text, true);
}

async function handleTalkText(session, member, rawText, fromVoice = false) {
  let text = rawText.trim();
  if (fromVoice) {
    if (hasWakeWord(text)) {
      session.armedUntil = Date.now() + 15000;
      text = stripWakeWord(text);
      if (!text) {
        await session.textChannel.send(`${member} 呼んだ？続けて話してね。`);
        return;
      }
    } else if (Date.now() > session.armedUntil) {
      return;
    }
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
    session.history.push({ role: "user", content: `${member.displayName}: ${text}` });
    const reply = await generateReply(session, text);
    session.history.push({ role: "assistant", content: reply });
    session.history.splice(0, Math.max(0, session.history.length - 24));
    await session.textChannel.send(`**Coderたん**\n${reply.slice(0, 1900)}`);
    await playTts(session, reply);
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
    const project = await generateProject(session, "Create the final completed project from this talk-coding session.");
    const attachments = await buildProjectAttachments(project);
    const links = await uploadAttachmentsToDrive(session.ownerId, attachments).catch((error) => {
      console.error("Drive upload failed:", error.message);
      return [];
    });
    const driveText = links.length ? `\nGoogle Drive: 保存しました。\n${links.slice(0, 5).join("\n")}` : "";
    await session.textChannel.send({
      content: `**${project.title}**\n${project.summary}\n\n${project.files.length} files generated with ${PUTER_CHAT_MODEL}.${driveText}`.slice(0, 2000),
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
    new SlashCommandBuilder().setName("talk").setDescription("トークコーディング管理").addSubcommand((sub) =>
      sub.setName("leave").setDescription("CoderたんをVCから退出させます")
    ),
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
  if (interaction.commandName === "coder") {
    await interaction.deferReply({ flags: 64 });
    try {
      const content = interaction.options.getString("content", true);
      const programmingLanguage = interaction.options.getString("programming_language", true);
      const model = interaction.options.getString("model") || DEFAULT_CODE_MODEL;
      await updateInteractionProgress(interaction, `コードを生成しています... モデル: \`${model}\``);
      const project = await generateProjectForCommand(content, programmingLanguage, model, buildMemoryContext(interaction));
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
      const response = await generateTextResponse(buildReviewPrompt(fullCode, programmingLanguage, buildMemoryContext(interaction)), model);
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
      const response = await generateTextResponse(buildDebugPrompt(errorText, fullCode || null, programmingLanguage, buildMemoryContext(interaction)), model);
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
        const project = await generateProjectForCommand(request, programmingLanguage, model, buildMemoryContext(interaction));
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
  if (interaction.commandName !== "talk") return;
  if (interaction.options.getSubcommand() === "leave") {
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
  const mentioned = message.mentions.users.has(client.user.id);
  const content = message.content.replace(`<@${client.user.id}>`, "").replace(`<@!${client.user.id}>`, "").trim();
  const session = sessions.get(message.guild.id);

  if (mentioned && isLeaveRequest(content)) {
    if (session && session.ownerId !== message.author.id) {
      await message.reply("開始した人だけが退出できます。");
      return;
    }
    await stopTalkSession(message.guild.id);
    await message.reply("CoderたんをVCから退出させました。");
    return;
  }

  if (mentioned) {
    const voiceChannel = findVoiceChannel(message);
    if (voiceChannel) {
      await startTalkSession(message, voiceChannel);
      return;
    }
  }

  if (session && message.channel.id === session.textChannelId && mentioned) {
    const member = await message.guild.members.fetch(message.author.id);
    await handleTalkText(session, member, content, false);
  }
});

client.login(DISCORD_TOKEN);
