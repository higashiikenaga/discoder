const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const childProcess = require("child_process");
const { Client, GatewayIntentBits } = require("discord.js");
const {
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  getVoiceConnection,
  joinVoiceChannel,
} = require("@discordjs/voice");
const prism = require("prism-media");
const speech = require("@google-cloud/speech");

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.VOICE_BRIDGE_GUILD_ID;
const channelId = process.env.VOICE_BRIDGE_CHANNEL_ID;
const languageCode = process.env.VOICE_BRIDGE_STT_LANGUAGE || "ja-JP";
const sttModel = process.env.TALK_CODING_STT_MODEL || "";
const saveDebugAudio = ["1", "true", "yes", "on"].includes((process.env.TALK_CODING_SAVE_STT_AUDIO || "false").toLowerCase());

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

if (!token || !guildId || !channelId) {
  emit({ type: "error", message: "DISCORD_TOKEN, VOICE_BRIDGE_GUILD_ID, and VOICE_BRIDGE_CHANNEL_ID are required." });
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
const speechClient = new speech.SpeechClient();
let connection = null;
let player = createAudioPlayer();
const subscriptions = new Map();

async function transcribePcm(userId, pcm) {
  if (!pcm || pcm.length < 48000) {
    emit({ type: "debug", message: `too little audio for ${userId}: ${pcm ? pcm.length : 0} bytes` });
    return;
  }
  const seconds = pcm.length / (48000 * 2 * 2);
  const rms = pcmRms16le(pcm);
  emit({ type: "debug", message: `sending ${seconds.toFixed(1)}s audio for ${userId} to Google (bytes=${pcm.length}, rms=${rms})` });
  try {
    if (saveDebugAudio) saveDebugWav(userId, pcm);
    const flac = pcmStereoToFlacMono16k(pcm);
    const [response] = await speechClient.recognize({
      config: {
        encoding: "FLAC",
        sampleRateHertz: 16000,
        languageCode,
        audioChannelCount: 1,
        enableAutomaticPunctuation: true,
        ...(sttModel ? { model: sttModel } : {}),
      },
      audio: { content: flac.toString("base64") },
    });
    const text = (response.results || [])
      .map((result) => result.alternatives && result.alternatives[0] && result.alternatives[0].transcript)
      .filter(Boolean)
      .join(" ")
      .trim();
    if (text) emit({ type: "transcript", user_id: userId, text });
    else emit({ type: "debug", message: `no transcript for ${userId}; results=${(response.results || []).length}` });
  } catch (error) {
    emit({ type: "error", message: `speech failed: ${error.message}` });
  }
}

function pcmStereoToFlacMono16k(pcm) {
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
      "flac",
      "pipe:1",
    ],
    { input: pcm, maxBuffer: 32 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${result.stderr.toString("utf8")}`);
  }
  return result.stdout;
}

function saveDebugWav(userId, pcm) {
  const file = path.join(os.tmpdir(), `discoder-node-stt-${userId}-${Date.now()}.wav`);
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
      file,
    ],
    { input: pcm, maxBuffer: 32 * 1024 * 1024 }
  );
  if (result.status === 0) emit({ type: "debug", message: `saved debug wav: ${file}` });
  else emit({ type: "debug", message: `debug wav save failed: ${result.stderr.toString("utf8")}` });
}

function pcmRms16le(buffer) {
  if (!buffer || buffer.length < 2) return 0;
  let sum = 0;
  let count = 0;
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const sample = buffer.readInt16LE(offset);
    sum += sample * sample;
    count += 1;
  }
  return Math.round(Math.sqrt(sum / Math.max(count, 1)));
}

function subscribeUser(userId) {
  if (!connection) return;
  if (subscriptions.has(userId)) return;
  const opus = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 1800 },
  });
  subscriptions.set(userId, opus);
  emit({ type: "debug", message: `subscribed ${userId}` });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const chunks = [];
  let bytes = 0;
  decoder.on("data", (chunk) => {
    chunks.push(chunk);
    bytes += chunk.length;
  });
  decoder.on("end", () => {
    subscriptions.delete(userId);
    const pcm = Buffer.concat(chunks, bytes);
    transcribePcm(userId, pcm);
  });
  opus.on("close", () => subscriptions.delete(userId));
  opus.on("error", (error) => {
    subscriptions.delete(userId);
    emit({ type: "debug", message: `opus stream error: ${error.message}` });
  });
  decoder.on("error", (error) => emit({ type: "debug", message: `decoder error: ${error.message}` }));
  opus.pipe(decoder);
}

async function subscribeCurrentMembers(guild, channel) {
  await guild.members.fetch();
  for (const [userId, member] of channel.members) {
    if (!member.user.bot) subscribeUser(userId);
  }
}

client.once("clientReady", async () => {
  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(channelId);
  connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  connection.subscribe(player);
  await subscribeCurrentMembers(guild, channel);
  setInterval(() => subscribeCurrentMembers(guild, channel).catch((error) => emit({ type: "debug", message: `subscribe scan failed: ${error.message}` })), 3000);
  connection.receiver.speaking.on("start", (userId) => {
    emit({ type: "debug", message: `speaking ${userId}` });
    subscribeUser(userId);
  });
  emit({ type: "ready", message: `joined ${channel && channel.name ? channel.name : channelId}` });
});

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    return;
  }
  if (payload.type === "stop") {
    const current = getVoiceConnection(guildId);
    if (current) current.destroy();
    client.destroy();
    process.exit(0);
  }
  if (payload.type === "play" && payload.audio_base64) {
    const file = path.join(os.tmpdir(), `discoder-node-tts-${Date.now()}.mp3`);
    fs.writeFileSync(file, Buffer.from(payload.audio_base64, "base64"));
    const resource = createAudioResource(file, { inputType: StreamType.Arbitrary });
    player.play(resource);
    player.once(AudioPlayerStatus.Idle, () => fs.rm(file, { force: true }, () => {}));
  }
});

client.login(token).catch((error) => {
  emit({ type: "error", message: `login failed: ${error.message}` });
  process.exit(1);
});
