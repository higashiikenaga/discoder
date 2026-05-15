# DisCoder

Discord.py bot that generates code with Gemini and sends the finished code back as files.

## Support / OFUSE

DisCoderをご利用いただき、ありがとうございます。
DisCoderは実験中のAI Discord Botです。
TTSや開発用のAPIなど、一部機能には開発者側のAI APIの利用料金も発生します。
開発・運用費の支援はこちら：
OFUSE: https://ofuse.me/a753ea67

支援は任意です。ありがとうございます。

## Setup

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m playwright install chromium
copy .env.example .env
```

Edit `.env` and set:

- `DISCORD_TOKEN`
- `GEMINI_API_KEY`
- `DISCORD_GUILD_ID` optional, but useful during development
- `TALK_CODING_TTS_API_KEY` and `TALK_CODING_TTS_API_URL` optional, for talk-coding TTS

## Run

```powershell
python bot.py
```

## Node.js Version

For DAVE/E2EE Discord voice receive, use Node.js 22.12.0 or newer. The current
Node bot depends on `@discordjs/voice` 0.19.x, `@snazzah/davey`, and
`sodium-native`.

Oracle Always Free deployment notes:

- Install Node.js 22 LTS or newer before running `npm install`.
- Keep secrets in `.env`; do not commit `.env`, token JSON files, databases, or SSH keys.
- Open outbound UDP for Discord voice. If you also expose Google OAuth, allow the configured `GOOGLE_OAUTH_PORT`.
- Run the bot with a process manager such as `systemd` or `pm2` after confirming `npm start` works.

Node版は `bot.js` を使います。Puter.jsでコード生成/STT/TTSを行い、完成時にzip、プレビュー画像、Google Drive保存まで実行します。

```powershell
npm install
npx playwright install chromium
.\discorder_node_start.bat
```

VC音声認識を使う場合は `opusscript` と `libsodium-wrappers` も必要です。`package.json` に入っているので、更新後に `npm.cmd install` を実行してください。`bytes=0` が続く場合はNode 22ではなくNode 20 LTSで起動してください。
VC接続が `connecting -> signalling` を繰り返す場合は、Windows Defender Firewallで `node.exe` のUDP通信が止まっている可能性があります。`allow_node_voice_firewall.bat` を管理者として実行してください。

`.env` には少なくとも次を設定してください。

- `DISCORD_TOKEN`
- `PUTER_CHAT_MODEL=gemini-3-flash-preview`

`PUTER_AUTH_TOKEN` は任意です。未設定の場合、Node版は初回実行時にPuterのブラウザログインを開き、取得したトークンを `node_puter_token.json` に保存します。このファイルは `.gitignore` 済みです。
AI応答が返らない場合は `PUTER_AI_TIMEOUT_MS=90000` を短く/長くして調整できます。

Google Driveに保存する場合は、Google CloudでOAuth 2.0 Webクライアントを作成して以下も設定します。

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI=http://localhost:8080/oauth2callback`
- 外部端末から連携する場合は `GOOGLE_PUBLIC_BASE_URL=https://your-domain.ngrok-free.app`

`discorder_node_start.bat` はngrokがPATHにあれば自動で起動します。`GOOGLE_PUBLIC_BASE_URL` を設定している場合は、その固定ドメインで `ngrok http --url=<domain> <GOOGLE_OAUTH_PORT>` を起動します。Google CloudのリダイレクトURIには `<GOOGLE_PUBLIC_BASE_URL>/oauth2callback` を登録してください。

Discordでは次を使います。

```text
/coder content:<what to build> programming_language:<select> model:<optional>
/review code:<code> programming_language:<select> model:<optional> file:<optional>
/debug error:<error/log> programming_language:<select> code:<optional> model:<optional> file:<optional>
/generate feature feature:<feature> programming_language:<select> model:<optional>
/drive connect
/drive status
/drive disconnect
/help
/support
/talk leave
/video prompt:<what to generate> quality:<480p|720p|1080p> duration:<1-5> reference_video:<optional video>
```

トークコーディング開始後、開始した人が `@DisCoder 完成` と送ると、Node版は最終プロジェクトを生成し、zipと `preview.png` を投稿します。Google Drive連携済みなら同じファイルをDriveにも保存します。
`/coder` と `/generate feature` の結果には、zip、`preview.png`、引用/出典用の `ASSET_SOURCES.md` が付きます。最初は本人だけに表示され、「公開」ボタンで同じファイルをチャンネルに投稿できます。

## Usage

Discord slash command names must be lowercase, so use:

```text
/coder 内容:<what to build> プログラミング言語:<select from menu> モデル:<select from menu>
/review コード:<code> プログラミング言語:<select from menu> モデル:<select from menu>
/debug エラー:<error/log> プログラミング言語:<select from menu> コード:<optional code> モデル:<select from menu>
/generate feature 機能:<feature to add> プログラミング言語:<select from menu> モデル:<select from menu>
/drive connect
/drive status
/drive disconnect
```

## Talk Coding

Mention the bot in a VC text chat or normal text channel and include the VC channel mention:

```text
@DisCoder #voice-channel 参加
@DisCoder #voice-channel PythonでDiscordのpingコマンドを書いて
```

After joining, mention the bot in the same text channel, or start the message with `コーダーたん！`, to get a Gemini `gemini-3-flash-preview` coding answer. If TTS is configured, Coderたん also plays the answer in VC.

The user who first started the session can send `@DisCoder 完成`. Coder-tan then says a short "こんな感じ？" style confirmation, posts the generated zip and preview screenshot into the VC text channel, and saves the same files to Google Drive when Drive integration is connected. After the preview, mention the bot or say `コーダーたん！` again to request fixes.

Session isolation:

- Talk coding keeps one active session per Discord server.
- Only the user who started the session can move, stop, or complete it.
- Requests are accepted only from the configured text channel and from users currently in that VC.
- Idle sessions are automatically closed after one hour.

Requirements and limits:

- Enable `MESSAGE CONTENT INTENT` for the bot in the Discord Developer Portal.
- Install FFmpeg and make sure `ffmpeg` is on PATH.
- `PyNaCl` is required for Discord voice playback.
- `discord-ext-voice-recv[extras_speech]` is used for VC audio receive. STT uses Google Cloud Speech-to-Text via `google-cloud-speech`; set `GOOGLE_APPLICATION_CREDENTIALS` or use Application Default Credentials.
- If voice receive causes Discord voice close code `4006`, set `TALK_CODING_ENABLE_VOICE_RECEIVE=false` to keep VC join/TTS/text mode enabled while disabling STT receive.
- Official Discord Bot API does not provide bot video/background streaming. This implementation posts generated screenshots/previews to the VC text channel instead.

The bot first sends the generated zip file and preview screenshot as an ephemeral message that only the command user can see.
Use the `公開` button on that message to publish the same result to the channel.
Generated zip files include `ASSET_SOURCES.md`, which lists declared visual asset sources and detected external image URLs.
The bot keeps short in-memory project context from the same user's commands in the same channel and includes it in later generations, reviews, and debug analysis.
When Google Drive is configured, connected users' generated zip and preview files are also saved to their Drive folder.
For users on other devices to connect Google Drive, expose the OAuth callback with a public HTTPS URL such as ngrok, set `GOOGLE_PUBLIC_BASE_URL`, and register `<public-url>/oauth2callback` in Google Cloud.
