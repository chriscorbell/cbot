<p align="center">
  <img src="assets/readme-banner.svg" alt="cbot: a team of AI agents, each with its own desktop" width="100%">
</p>

cbot runs a small team of always-on AI agents for one person. Each bot is a [Hermes Agent](https://github.com/NousResearch/hermes-agent) with its own name, instructions, memory, routines and Linux desktop. You give a bot work in a chat, and it does the work in its own Chrome and terminal while you watch.

Everything runs on one machine. The only outside services are the model provider (none, with a self-hosted model), a SearXNG instance for search, and Open-Meteo for weather cards.

## Features

- Chat that shows each step of a task as the bot works
- A desktop per bot, with Chrome, a terminal and files, that you can watch or take control of
- Routines on a cron schedule, and check-ins from the primary bot
- Group chats, and bots that message each other
- Memory you can review and prune
- Search (⌘K) across bots, every bot's current chat, and Library files and folders
- A Library of the files bots save and the files you attach
- Voice calls answered by the bot's own agent, with all its tools, and dictation. They cancel the bot's echo in the page, so they work on speakers; talking over the bot stops it, and a noise or a "yeah" only pauses it. On a call the bot hears what happens in its text chat as it happens and can post links, lists and other things better read than heard there; afterwards the text chat's agent knows what was said on the call
- Claude, ChatGPT, Grok and Copilot subscriptions; Anthropic, OpenAI, Gemini, xAI, OpenRouter and DeepSeek API keys; or a self-hosted OpenAI-compatible model

## Quick start

Development runs in Docker, because the server starts real X displays, Chrome and Hermes gateways. Don't run it on your machine outside the container.

```bash
cp .env.example .env
CBOT_PORT=8788 docker compose -p cbot-dev up -d --build
```

Open http://127.0.0.1:8788 right away and create the account: until it exists, anyone who can reach the app can create it. A short setup follows, which makes your first bot: its name and look, its label, About and instructions, and the model it runs on, from an API key, a Claude token, a subscription sign-in or your own server. That bot is the primary one, your main point of contact.

## Models

Choose a bot's provider, model and thinking effort in its settings under Model & voice. A new bot copies the primary bot's model, but not its ChatGPT or Grok sign-in: each bot signs in to those itself. The Claude and Copilot tokens in Settings > Providers are shared. Keys, tokens and the self-hosted address are set once for every bot in Settings > Providers; saving one restarts each bot's agent, an idle one at once and a busy one before its next turn.

| Provider | Access |
|---|---|
| Claude subscription | A Claude token in Settings > Providers, which every bot uses. Run `claude setup-token` on a computer with Claude Code to get one |
| ChatGPT subscription | Sign in with a code, for each bot |
| Grok subscription (SuperGrok or X Premium+) | Sign in with a code, for each bot |
| GitHub Copilot | Sign in to GitHub with a code, from a bot's settings or Settings > Providers, or paste a GitHub token with Copilot access there. Every bot uses it |
| Anthropic API | API key in Settings > Providers. Bots on the Claude subscription keep using it |
| OpenAI API, Google Gemini, xAI API, OpenRouter | API key in Settings > Providers |
| DeepSeek API | API key in Settings > Providers. A bot with no model chosen runs on `deepseek-flash`, and voice call summaries use it |
| Self-hosted | The address of an OpenAI-compatible server (vLLM, llama.cpp, Ollama), and its key if it has one, in Settings > Providers. Its models are the ones the server lists |

Signing in to ChatGPT, Grok or Copilot shows a link and a short code. Open the link on any device where you're signed in, enter the code and approve; the sign-in finishes by itself. Nothing happens on the bot's screen.

## Approvals

Settings > Permissions decides whether the bots ask before a command or change that is flagged as risky, such as deleting files with `rm -rf` or editing `~/.ssh/config`. Off, the default, never asks. Smart asks unless the bot's model judges the action low-risk, and Ask always asks. A request shows as a card in the bot's chat, during a voice call too, and the bot waits up to five minutes for Allow, Always allow or Don't allow. Always allow counts for every bot and can be taken back under Allow without Asking. Never Allow lists command patterns, such as `git push --force*`, that the bots refuse even with approvals off.

## Production

Production gets a machine of its own: Ubuntu 26.04, with about 1 GB of RAM per bot and 2 GB more for speech. The server runs as a systemd service, and the bots run as root directly on the host, so whatever they install stays installed.

```bash
cp .env.example .env.prod   # set CBOT_HOST in it; every deploy copies it to /etc/cbot/env
scripts/deploy.sh           # deploy the committed main branch to CBOT_HOST
scripts/deploy.sh <commit>  # deploy that commit, or roll back to it
```

A commit has to pass `npm run check` before it deploys. The first deploy to a fresh machine provisions it. A deploy restarts only the server, which takes over the running displays, Chromes and gateways. Put HTTPS in front with `tailscale serve --bg --https=8787 http://127.0.0.1:8787`, since browsers allow the microphone only on HTTPS.

## Settings

| Variable | Default | Effect |
|---|---|---|
| `MAX_BOTS` | 4 | Most bots the app will create |
| `TZ` | UTC | The bots' time zone: their clocks, and routines and check-ins without a zone of their own |
| `CBOT_NO_SCHEDULER` | unset | `1` turns off routines and check-ins, for a dev copy of production data |

[.env.example](.env.example) lists the ports and paths. Model keys, subscription tokens, the self-hosted model and the SearXNG address (for the bots' `web_search`; without one they search in Chrome) are set in Settings > Providers. The first start of this version copies `DEEPSEEK_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `COPILOT_GITHUB_TOKEN`, `SEARXNG_URL` and the other providers' keys from the environment into the app once; after that the environment is not read for them, and they can come out of `.env`.

To reset a forgotten password, run `npm run reset-account -w server` with the server's `DATA_DIR` (in the dev container, `docker exec cbot-dev-cbot-1 node server/dist/reset-account.js`). The next visit creates a new account, and the bots and chats stay.

To start over from nothing, use Reset cbot in Settings > General. It asks twice, then erases every bot, chat, file, provider key and setting and the account, and cbot restarts as a fresh install. Programs the bots installed on the computer stay.

## Development

```bash
npm ci
npm run check                                       # typecheck, lint and unit tests
CBOT_API=http://127.0.0.1:8788 npm run dev -w web   # Vite against the dev container; add ?fixtures for sample rows
```

Rebuild the dev container to try server changes. The Playwright scripts in `tests/` run against a live app, and each one's header says how.

```text
server/   Node server: API, turns, Hermes gateways, screens, voice relay
web/      React app
speech/   speech service: recognition, and Phonon's voices
zonos3/   ZONOS3-Mini voice server (off; speech/README.md says how to run it)
scripts/  deploy, release and host provisioning
deploy/   systemd unit and the speech services' Compose file
tests/    end-to-end scripts
```

[AGENTS.md](AGENTS.md) explains how the code is organised and the rules for changing it. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how it runs, including turns, screens, group chats and voice.

## Stack

- TypeScript, Node, Hono, SQLite and zod
- React 18, Vite and zustand
- Hermes Agent for each bot's model calls, memory and tools
- TigerVNC, Chrome and noVNC for the desktops
- sherpa-onnx with Parakeet, Nemotron and Silero VAD for listening; Phonon for speaking

## License

cbot is free software under the [GNU General Public License v3.0 or later](LICENSE).
