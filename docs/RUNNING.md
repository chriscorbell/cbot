# Running Dispatch

How to look after a Dispatch machine once the [installer](../README.md#install) has set it up: updates, settings, HTTPS, models, notifications, approvals, backups, and getting back in. [ARCHITECTURE.md](ARCHITECTURE.md) explains how it all works underneath.

## Updating

Dispatch checks GitHub for a new release a minute after it starts and every six hours after that. When there is one, **Update available** shows above your account in the sidebar. It opens **Settings** > **General** > **Updates**:

- **Update** installs it. The page shows each step and reloads on the new version when it's done.
- **What's new** lists the changes.
- **Check Now** asks GitHub straight away.

**Update** runs the installer of the version you have again. Running the installer yourself does the same:

```bash
curl -fsSL https://github.com/chriscorbell/dispatch/releases/latest/download/install.sh | bash
```

It downloads the newest release, already built, and checks that one of Dispatch's release keys signed it ([SECURITY.md](../SECURITY.md#how-releases-are-checked)). Then it unpacks it beside the running one and restarts the server, which takes over the bots' screens, Chromes and agents as they are. The settings, bots and chats stay. A release brings its own Node, so it doesn't depend on the machine's. A release that isn't signed, or is older than the one running, isn't installed.

When an update fails, Dispatch keeps the version it had:

- If the installer fails, `journalctl -u dispatch-update` says why.
- If the new version installs but doesn't start within a minute, Dispatch goes back to the version before it, with the database as it was before the update. **Updates** says which version didn't start. The copy of the database stays beside it as `/var/lib/dispatch/dispatch.db.before-update`.

Running the installer again tries again.

### Following a branch

The installer writes where it installed from to `/etc/dispatch/source`, and updates follow that. To install a branch instead, give the installer `DISPATCH_REF`, as in `curl -fsSL …/install.sh | DISPATCH_REF=main bash`. A branch is downloaded as source and built on the machine. Nothing checks a branch's signature, and updates then follow its newest commit. Running the installer without `DISPATCH_REF` goes back to releases.

### The machine's other packages

The machine installs its security updates every day on its own (unattended-upgrades), Google Chrome's among them. Dispatch then starts each bot's Chrome again on the new version once that bot isn't busy: no turn, no call, and nobody watching its screen. Its sign-ins stay; its open tabs close.

Other packages from outside the distribution (Node.js, Docker) update with `sudo apt update && sudo apt upgrade`.

## The bots' account

Every bot runs as one ordinary account: the one you ran the installer from, which the installer writes to `/etc/dispatch/env` as `DISPATCH_USER`. It refuses to run from a root login unless `DISPATCH_USER=<account>` names another account. The bots' agents, screens, Chromes and apps run as that account, and their files are in its home, under `~/dispatch`:

| Folder | Holds |
|---|---|
| `~/dispatch/engines/<botId>` | Each bot's Hermes home: its settings, keys, sign-ins, memory and sessions |
| `~/dispatch/files/<botId>` | Each bot's Library, also the folder it works in |
| `~/dispatch/profiles/<botId>` | Each bot's Chrome profile |

The account may run anything as root without a password (`/etc/sudoers.d/dispatch`), so a bot can install what it needs. The server itself runs as root, and only root can read its data in `/var/lib/dispatch` (the database, the secret that signs the bots' tokens, the setup code). To look at a bot's files as the bots see them, use that account: `sudo -iu <account>`.

### Logs and units

| To see | Run |
|---|---|
| The server's log | `journalctl -u dispatch -f` |
| The installer's log | `/var/log/dispatch/install.log` |
| Every unit Dispatch runs | `systemctl list-units 'dispatch-*'` |
| The bots' agents | `journalctl -u 'dispatch-gateway@*'` |
| The bots' Chromes | `journalctl -u 'dispatch-chrome-*'` |
| Each bot's memory against its limit | `systemctl status 'dispatch-bot-*.slice'` |

The server runs as the systemd service `dispatch`. Each bot's agent, screen and Chrome are units of their own, so restarting `dispatch` leaves them running.

## Settings

The installer writes `/etc/dispatch/env`. After changing it, run `systemctl restart dispatch`.

| Variable | Default | Effect |
|---|---|---|
| `MAX_BOTS` | 4 | Most bots the app will create. Each one runs a screen, a Chrome and an agent, about 1 GB of memory |
| `TZ` | UTC | The bots' time zone: their clocks, and routines and check-ins without a zone of their own |
| `HOST` | every address | The address the server listens on. `127.0.0.1` keeps Dispatch to the machine itself and to Tailscale Serve |
| `HTTPS` | unset | `1` serves HTTPS with Dispatch's own certificate, and plain HTTP only to the machine itself. The installer sets it |
| `DISPATCH_NO_SCHEDULER` | unset | `1` turns off routines and check-ins, for a copy of another machine's data |

For an unattended install, set `DISPATCH_TZ`, `DISPATCH_MAX_BOTS` and `DISPATCH_TAILSCALE` (`1` or `0`) for the installer; [its header](../scripts/install.sh) lists the rest. [.env.example](../.env.example) lists the ports and paths.

Model keys, subscription tokens, the self-hosted model and the SearXNG address are set in the app, under **Settings** > **Providers**. Without a SearXNG address the bots search the web in Chrome.

## HTTPS

Voice calls and notifications need HTTPS, because browsers allow the microphone and the service worker only there. No public authority signs a certificate for an address on a local network, so Dispatch signs its own, for the machine's name and address, and browsers warn that the connection isn't private. Continue past the warning once on each device, or stop it by installing the certificate from **Settings** > **General** > **Certificate** and trusting it:

- iPhone and iPad: install the downloaded profile in Settings, then turn it on under General > About > Certificate Trust Settings
- Android: install it as a CA certificate, under Settings > Security (the path varies by phone)
- macOS: add it in Keychain Access and set it to Always Trust
- Windows: open it, choose Install Certificate, and place it in Trusted Root Certification Authorities

Continuing past the warning is enough for voice calls, but not for notifications: browsers run Dispatch's service worker only on an address they trust. Trust the certificate or use the Tailscale address on the devices that should get them.

The certificate vouches for this machine only. When the machine's address changes, Dispatch makes a new one, and devices that trusted the old one need the new one.

Tailscale, which the installer offers, adds an address that browsers trust without a warning and that works from anywhere on your tailnet: `https://<machine>.<tailnet>.ts.net`. To add it later, put Tailscale on the machine and run `tailscale serve --bg --https=443 http://127.0.0.1:8787`. To keep Dispatch off the local network then, set `HOST=127.0.0.1` in `/etc/dispatch/env`.

## Models

Choose a bot's provider, model, thinking effort and voice in its settings under **Model & voice**. A new bot copies the primary bot's model, but not its ChatGPT or Grok sign-in: each bot signs in to those itself. Keys, tokens and the self-hosted address are set once for every bot in **Settings** > **Providers**. Saving one restarts each bot's agent: an idle one at once, a busy one before its next turn.

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

Dispatch works in a phone's browser, and **Add to Home Screen** (Safari's Share menu, or Chrome's menu) gives it an icon and a window of its own. The sidebar opens from the button at the top left. Hold a message to react, reply or copy its text, and hold a bot in the sidebar for its menu (mark as unread, copy, hide, delete). The chat stays above the keyboard while you type.

The screen stays on during a voice call, since a phone that locks stops the page and with it the call. On Android, Dispatch added to the home screen shows in the share sheet: what you share goes in the composer of the chat that opens.

## Notifications

Turn on **Settings** > **General** > **Notifications on This Device** on each phone or computer that should hear from the bots, and allow notifications when the browser asks. A notification comes when a bot writes, needs your approval or asks you something, unless its chat is open in front of you on any device. Tapping it opens that chat, and the home-screen icon shows how many chats are unread where the system has a badge. **Send a Test** checks that one reaches this device.

- iPhone and iPad (iOS 16.4 or later): add Dispatch to the Home Screen first and turn them on in the app from there. Safari in a tab has none.
- The address has to be one the browser trusts: the Tailscale address, or Dispatch's own certificate installed and trusted (see [HTTPS](#https)).
- Each browser's maker carries the notifications (Apple, Google, Mozilla or Microsoft), so the machine needs to reach the internet. They are encrypted for the device, so the push service can't read them.
- Signing out on a device stops its notifications. Signing in again starts them again.

## Approvals

**Settings** > **Permissions** decides whether the bots ask before a command or change that is flagged as risky, such as deleting files with `rm -rf` or editing `~/.ssh/config`:

- **Smart**, the default, asks unless the bot's model judges the action low-risk.
- **Off** never asks.
- **Ask** always asks.

A request shows as a card in the bot's chat, during a voice call too, and the bot waits up to five minutes for **Allow**, **Always allow** or **Don't allow**. **Always allow** counts for every bot and can be taken back under **Allow without Asking**. **Never Allow** lists command patterns, such as `git push --force*`, that the bots refuse even with approvals off.

## A forgotten password

On the machine, run:

```bash
sudo DATA_DIR=/var/lib/dispatch node --env-file=/etc/dispatch/env /srv/dispatch/current/server/dist/reset-account.js
```

It prints a new setup code. The next visit creates a new account with it, and the bots and chats stay. In the development container, it's `docker exec dispatch-dev-dispatch-1 node server/dist/reset-account.js`.

## The setup code

Until an account exists, making one takes a one-time setup code, so that nobody else who can reach Dispatch makes it first. The installer prints a link that carries it. Without the link, the first-run form asks for the code. It's on the machine in `/var/lib/dispatch/setup-code` (`sudo cat` it), and in the log (`journalctl -u dispatch | grep 'setup code'`). In the development container, it's `docker exec dispatch-dev-dispatch-1 cat /data/setup-code`.

## Backing up

To copy what Dispatch keeps on the machine into one file, while it runs:

```bash
sudo /srv/dispatch/current/scripts/backup.sh                 # /var/backups/dispatch-<time>.tar.gz
sudo /srv/dispatch/current/scripts/backup.sh /mnt/usb/dispatch.tar.gz
```

The file holds:

- the database: the account, bots, chats, routines, the task board, settings and provider keys,
- the secret the bots' tokens are signed with, and the certificate,
- each bot's Hermes home (memory, sessions, keys and sign-ins) without the Python packages it downloaded, its Library, and its Chrome profile without Chrome's caches.

The databases are copied whole even while they're written to. The file has keys and sign-ins in it, so only root can read it; keep it somewhere safe. The machine's settings in `/etc/dispatch/env` aren't in it, since the installer writes them for each machine.

To put a backup back, on this machine or another one you've installed Dispatch on:

```bash
sudo /srv/dispatch/current/scripts/restore.sh /var/backups/dispatch-<time>.tar.gz
```

It asks first. Then it stops Dispatch and the bots, moves what's there now aside, unpacks the backup, and starts Dispatch again. What was there stays in `/var/lib/dispatch.before-restore-<time>` and `~/dispatch.before-restore-<time>` (in the bots' account's home) for you to delete once you're happy.

A backup from an older version is brought up to date as Dispatch starts. One from a newer version needs this machine updated first.

## Starting over

**Settings** > **General** > **Reset Dispatch** asks twice, then erases every bot, chat, file, provider key and setting and the account, and Dispatch restarts as a fresh install. The page reloads into the first-run form with the new setup code already filled in. Programs the bots installed on the machine stay. To remove Dispatch altogether, use the [uninstaller](../README.md#uninstall).

## Publishing a release

Installs and updates take the newest signed `vX.Y.Z` tag whose release is published, and the build GitHub Actions made from it. To publish one from a checkout, on Linux (it builds in Docker on anything but x86-64):

```bash
scripts/publish.sh v1.2.0
```

1. It tags `main` as GitHub has it, after `npm run check` passes on that commit. It signs the tag with whichever key in `release_signers` your ssh-agent holds (`ssh-add -L` lists them); the list is in `scripts/install/install-release.sh`, part of `scripts/install.sh`. Before pushing, it checks the tag with this commit's installer and with the last release's, since machines updating run the last release's.
2. The pushed tag starts `.github/workflows/release.yml`. It builds the release once with `scripts/build-release.sh`, builds the speech image and pushes it to `ghcr.io/chriscorbell/dispatch-speech`, and attaches these to a draft release: the tarball, `install.sh`, `uninstall.sh`, `manifest.json` (the version, commit and speech image by digest) and `SHA256SUMS` of them. `publish.sh` waits for it.
3. It builds the same commit itself and stops unless the result is the same as the tarball, file for file. Then it signs `SHA256SUMS` with the same key, checks the files the way the installer will, attaches the signature and publishes the release, whose notes list the commits since the last release.

If it stops after pushing the tag, the tag and the draft release stay; fix what it says, delete both, and publish again. Machines go on installing and updating to the last published release meanwhile, since a tag whose release is still a draft is passed over.

To sign with a new key, add it to `release_signers` and publish that change with a key already listed. Machines trust the new key once they have that release.

The first time the workflow pushes the speech image, GitHub makes the `dispatch-speech` package. It is linked to this repository and should be public like it. If **Packages** on GitHub shows it private, make it public in its settings, or machines can't download it.

## Deploying from a checkout

To put your own commits on the machine instead of the newest release, deploy them over SSH:

```bash
cp .env.example .env.prod   # set DISPATCH_HOST and DISPATCH_USER in it; every deploy copies it to /etc/dispatch/env
scripts/deploy.sh           # deploy the committed main branch to DISPATCH_HOST
scripts/deploy.sh <commit>  # deploy that commit, or roll back to it
```

- A commit has to pass `npm run check` before it deploys. The machine builds it with `scripts/build-release.sh`, as GitHub Actions builds a release, and builds the speech image from its source.
- The first deploy to a fresh machine provisions it. A deploy restarts only the server, which takes over the running displays, Chromes and agents.
- `DISPATCH_USER` names the ordinary account on the machine the bots run as, and each deploy gives it passwordless sudo, as the installer does. `deploy.sh` refuses a `.env.prod` without it. Dispatch doesn't start without one either: `DISPATCH_USER=root` runs the bots as root, with Chrome's sandbox off, only when it says so.
- `.env.prod` replaces `/etc/dispatch/env`, so set `HOST` and `HTTPS` there if you want them. `TAILSCALE_SERVE=1` has Tailscale Serve give Dispatch an address on your tailnet on port 8787 (Tailscale has to be on the machine already).

## Development

Development runs in Docker, because the server starts real X displays, Chrome and Hermes gateways. Don't run it on your machine outside the container.

```bash
cp .env.example .env
DISPATCH_PORT=8788 docker compose -p dispatch-dev up -d --build   # then open http://127.0.0.1:8788
npm ci
npm run check                                       # typecheck, lint and unit tests
DISPATCH_API=http://127.0.0.1:8788 npm run dev -w web   # Vite against the dev container; add ?fixtures for sample rows
```

Rebuild the dev container to try server changes. The container boots systemd, as a host does: the server is `dispatch.service`, and each bot's screen, Chrome and agent are units of their own. So the container behaves like a real install: a server restart leaves the bots running, and each bot has its memory limit. The server's log is in the journal: `docker exec dispatch-dev-dispatch-1 journalctl -u dispatch -f`.

The scripts in `tests/` run against a live app, and each one's header says how:

- `tests/supervision.mjs` checks the units against a fresh container, with a bot on `tests/fake-llm.mjs` so it needs no keys. CI runs it on changes to how the bots run, and every night.
- `tests/update.mjs` installs a release of the checkout, signed with a key it makes, on a fresh systemd container. It updates it, checks that an update whose server never answers is rolled back with the app saying so, and updates once more. CI runs it on changes to the installer, `release.sh` and the units, and every night.
- The Playwright scripts (`tests/e2e.mjs`, `tests/voice-*.mjs`) need real gateways, screens and speech.

Every pull request runs `npm run check` and shellcheck in GitHub Actions, and `main` takes only changes that pass. The app and speech images are built too when a change touches what goes into them.

```text
server/   Node server: API, turns, Hermes gateways, screens, voice relay
web/      React app
speech/   speech service: recognition, and Phonon's voices
scripts/  install and uninstall (parts in scripts/install/, joined by scripts/bundle.sh), build, publish, deploy, release, backup and host provisioning
deploy/   systemd unit and the speech services' Compose file
tests/    end-to-end scripts
```
