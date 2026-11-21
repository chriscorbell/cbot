# Running cbot

How to look after a cbot machine once the [installer](../README.md#install) has set it up: updates, settings, HTTPS, models, approvals, and getting back in. [ARCHITECTURE.md](ARCHITECTURE.md) explains how it all works underneath.

## Updating

cbot checks GitHub for a newer version a minute after it starts and every six hours after that. When there is one, **Update available** shows above your account in the sidebar. It opens **Settings** > **General** > **Updates**, where **Update** installs it and **What's new** lists the changes. The page shows each step and reloads on the new version when it's done. **Check Now** asks GitHub straight away.

The button runs the installer again for you. Running it yourself does the same: it downloads the newest commit, builds it beside the running one and restarts the server, which takes over the bots' screens, Chromes and agents as they are. The settings, bots and chats stay.

```bash
curl -fsSL https://raw.githubusercontent.com/chriscorbell/cbot/main/scripts/install.sh | bash
```

Updates follow the repository and branch the installer last installed from, which it writes to `/etc/cbot/source`. When an update started from the app fails, cbot keeps running the version it had, and `journalctl -u cbot-update` says why.

The server runs as the systemd service `cbot`: `journalctl -u cbot -f` follows its log, and the installer's own log is `/var/log/cbot/install.log`.

## Settings

The installer writes `/etc/cbot/env`. After changing it, run `systemctl restart cbot`.

| Variable | Default | Effect |
|---|---|---|
| `MAX_BOTS` | 4 | Most bots the app will create. Each one runs a screen, a Chrome and an agent, about 1 GB of memory |
| `TZ` | UTC | The bots' time zone: their clocks, and routines and check-ins without a zone of their own |
| `HOST` | every address | The address the server listens on. `127.0.0.1` keeps cbot to the machine itself and to Tailscale Serve |
| `HTTPS` | unset | `1` serves HTTPS with cbot's own certificate, and plain HTTP only to the machine itself. The installer sets it |
| `CBOT_NO_SCHEDULER` | unset | `1` turns off routines and check-ins, for a copy of another machine's data |

For an unattended install, set `CBOT_TZ`, `CBOT_MAX_BOTS` and `CBOT_TAILSCALE` (`1` or `0`) for the installer; [its header](../scripts/install.sh) lists the rest. [.env.example](../.env.example) lists the ports and paths.

Model keys, subscription tokens, the self-hosted model and the SearXNG address are set in the app, under **Settings** > **Providers**. Without a SearXNG address the bots search the web in Chrome.

## HTTPS

Voice calls need HTTPS, because browsers allow the microphone only there. No public authority signs a certificate for an address on a local network, so cbot signs its own, for the machine's name and address, and browsers warn that the connection isn't private. Continue past the warning once on each device, or stop it by installing the certificate from **Settings** > **General** > **Certificate** and trusting it:

- iPhone and iPad: install the downloaded profile in Settings, then turn it on under General > About > Certificate Trust Settings
- Android: install it as a CA certificate, under Settings > Security (the path varies by phone)
- macOS: add it in Keychain Access and set it to Always Trust
- Windows: open it, choose Install Certificate, and place it in Trusted Root Certification Authorities

The certificate vouches for this machine only. When the machine's address changes, cbot makes a new one, and devices that trusted the old one need the new one.

Tailscale, which the installer offers, adds an address that browsers trust without a warning and that works from anywhere on your tailnet: `https://<machine>.<tailnet>.ts.net`. To add it later, put Tailscale on the machine and run `tailscale serve --bg --https=443 http://127.0.0.1:8787`. To keep cbot off the local network then, set `HOST=127.0.0.1` in `/etc/cbot/env`.

## Models

Choose a bot's provider, model and thinking effort in its settings under **Model & voice**. A new bot copies the primary bot's model, but not its ChatGPT or Grok sign-in: each bot signs in to those itself. Keys, tokens and the self-hosted address are set once for every bot in **Settings** > **Providers**; saving one restarts each bot's agent, an idle one at once and a busy one before its next turn.

| Provider | Access |
|---|---|
| Claude subscription | A Claude token in Settings > Providers, which every bot uses. Run `claude setup-token` on a computer with Claude Code to get one |
| ChatGPT subscription | Sign in with a code, for each bot |
| Grok subscription (SuperGrok or X Premium+) | Sign in with a code, for each bot |
| GitHub Copilot | Sign in to GitHub with a code, from a bot's settings or Settings > Providers, or paste a GitHub token with Copilot access there. Every bot uses it |
| Anthropic API | API key in Settings > Providers. Bots on the Claude subscription keep using it |
| OpenAI API, Google Gemini, xAI API, OpenRouter | API key in Settings > Providers |
| DeepSeek API | API key in Settings > Providers. A bot with no model chosen runs on `deepseek-flash` |
| Self-hosted | The address of an OpenAI-compatible server (vLLM, llama.cpp, Ollama), and its key if it has one, in Settings > Providers. Its models are the ones the server lists |

Signing in to ChatGPT, Grok or Copilot shows a link and a short code. Open the link on any device where you're signed in, enter the code and approve; the sign-in finishes by itself.

## On a phone

cbot works in a phone's browser, and **Add to Home Screen** (Safari's Share menu, or Chrome's menu) gives it an icon and a window of its own. The sidebar opens from the button at the top left. Hold a message to react, reply or copy its text, and hold a bot in the sidebar for its menu (mark as unread, copy, hide, delete). The chat stays above the keyboard while you type.

## Approvals

**Settings** > **Permissions** decides whether the bots ask before a command or change that is flagged as risky, such as deleting files with `rm -rf` or editing `~/.ssh/config`. **Smart**, the default, asks unless the bot's model judges the action low-risk; **Off** never asks; **Ask** always asks. A request shows as a card in the bot's chat, during a voice call too, and the bot waits up to five minutes for Allow, Always allow or Don't allow. Always allow counts for every bot and can be taken back under **Allow without Asking**. **Never Allow** lists command patterns, such as `git push --force*`, that the bots refuse even with approvals off.

## A forgotten password

On the machine, run:

```bash
sudo DATA_DIR=/var/lib/cbot node /srv/cbot/current/server/dist/reset-account.js
```

The next visit creates a new account, and the bots and chats stay. In the development container, it's `docker exec cbot-dev-cbot-1 node server/dist/reset-account.js`.

## Starting over

**Settings** > **General** > **Reset cbot** asks twice, then erases every bot, chat, file, provider key and setting and the account, and cbot restarts as a fresh install. Programs the bots installed on the machine stay. To remove cbot altogether, use the [uninstaller](../README.md#uninstall).

## Deploying from a checkout

To put your own commits on the machine instead of the newest on GitHub, deploy them over SSH:

```bash
cp .env.example .env.prod   # set CBOT_HOST in it; every deploy copies it to /etc/cbot/env
scripts/deploy.sh           # deploy the committed main branch to CBOT_HOST
scripts/deploy.sh <commit>  # deploy that commit, or roll back to it
```

A commit has to pass `npm run check` before it deploys. The first deploy to a fresh machine provisions it. A deploy restarts only the server, which takes over the running displays, Chromes and agents. `.env.prod` replaces `/etc/cbot/env`, so set `HOST` and `HTTPS` there if you want them.

## Development

Development runs in Docker, because the server starts real X displays, Chrome and Hermes gateways. Don't run it on your machine outside the container.

```bash
cp .env.example .env
CBOT_PORT=8788 docker compose -p cbot-dev up -d --build   # then open http://127.0.0.1:8788
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
scripts/  install, uninstall, deploy, release and host provisioning
deploy/   systemd unit and the speech services' Compose file
tests/    end-to-end scripts
```
