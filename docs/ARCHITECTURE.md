# Architecture

Dispatch is a Node server (`server/`) and a React web app (`web/`) that run on one machine together with every bot's screen, Chrome and Hermes gateway. In production that machine is a host of its own and the server a systemd service; in development it is the `dispatch-dev` container. Both are set up by `scripts/provision.sh`.

Two scripts put Dispatch on a host, and both hand it to `scripts/release.sh` there:

- `scripts/install.sh` puts a release from GitHub on a host, built by GitHub Actions with `scripts/build-release.sh` and signed.
- `scripts/deploy.sh` puts a commit from a checkout, which the host builds with the same script.

Hermes owns each bot's agent loop, history, memory, tools and model access. The server adds what Hermes does not have: the chat, one dressed screen per bot and a viewer for it, the app's own tools, routines and check-ins, the Library, group chats, and voice calls.

```text
browser
  │ HTTP + SSE (GET /api/events), VNC and voice calls over WebSocket, behind the session cookie
  ▼
server: Node, Hono, SQLite ──── displays.ts, desk.ts, vnc.ts ────────────┐
  │                        ▲                                             │
  │ POST /v1/runs          │ MCP: POST /mcp/<botId>, bearer token        ▼
  ▼                        │                                  X display per bot:
Hermes gateway, one per bot┘── browser (DevTools), terminal ──►  Xvnc, xfwm4, Chrome
  │
  ▼
model provider, SearXNG

server ── voice-relay.ts ──► speech container (Phonon, Parakeet, Nemotron, Silero VAD)
                     └────────► the bot's gateway (/v1/runs)
```

## Where each piece lives

| Piece | Where | What it does |
|---|---|---|
| API and realtime | `server/src/app.ts`, `routes*.ts`, `lib/hub.ts`, `lib/validate.ts` | JSON over HTTP, plus one Server-Sent Events stream (`GET /api/events`) carrying row updates, live state, roster, computer, routine and memory changes, and updates of Dispatch itself. `app.ts` builds the app without starting anything; `index.ts` starts the process. Every request body is checked against a zod schema |
| Search | `search.ts` | `GET /api/search` finds messages in each bot's current chat and files in each Library by name, bounded per bot; the browser matches bot names itself |
| HTTPS | `https.ts`, `httpsApi` in `routes-config.ts` | With `HTTPS=1`, HTTPS and plain HTTP on one port, with a certificate Dispatch signs itself. See [HTTPS](#https) |
| Updates | `updates.ts`, `UpdatePill` in `web/src/components/Sidebar.tsx`, `UpdatesSection` in `config/AppSettings.tsx` | On a machine the installer set up, offers a newer release from GitHub and installs it, rolling back one that doesn't start. See [Updates](#updates) |
| Contracts | `types.ts`, `contract.ts`, `voice-protocol.ts` | What server and web share, imported by the web app as `@shared/*`: domain types and server events, HTTP responses, and a voice call's messages |
| Database | `db.ts`, `store.ts` | The whole schema with numbered migrations (`PRAGMA user_version`) and a record type per table. `store.ts` reads and writes bots and rows |
| Sign-in | `lib/auth.ts`, `routes-auth.ts` | The owner's one account, its setup code, the first-run setup wizard, sessions, and the checks on requests from other sites. See [Signing in and first-run setup](#signing-in-and-first-run-setup) |
| Turns | `agent/turns.ts`, `agent/transcript.ts`, `agent/live.ts`, `agent/prompt.ts` | One runner per bot runs its turns one at a time. A turn makes sure the bot's screen is ready, starts a Hermes run on the conversation's session (`POST /v1/runs`, with the app's instructions, which carry the bot's skills: up to 20,000 characters each and 50,000 in all), and a TurnTranscript turns the run's events into rows. `live.ts` holds what each bot is doing now |
| Engines | `engine.ts` | One Hermes home and gateway per bot: writes the home, starts the gateway's unit or keeps the one that runs, lists the providers and marks the ones that sign in with a code |
| Units | `units.ts`, `deploy/`, `scripts/install-units.sh` | systemd runs what each bot has on the computer: its display, gateway, Chrome and apps, each bot's in a slice of its own with a memory limit (below) |
| The bots' account | `account.ts`, `scripts/install-units.sh` | Every bot runs as one ordinary account, `DISPATCH_USER`, which may sudo; the server stays root (below) |
| Sign-ins | `signin.ts` | ChatGPT, Grok and Copilot sign in with the OAuth device flow: a link and a short code the user approves on any device. See [Subscription sign-ins](#subscription-sign-ins) |
| Provider settings | `settings.ts` | Model keys, subscription tokens, the self-hosted endpoint and the SearXNG address, one row each in `settings`, set in Settings > Providers (`GET`/`PUT /api/providers`). The browser learns only whether a secret is set and its last four characters |
| App tools | `mcp.ts`, `agent/tools.ts` | An MCP endpoint per bot (`POST /mcp/<botId>`). Tools: `save_file`, `create_routine`, `list_routines`, `update_routine`, `delete_routine`, `set_checkins`, `send_to_bot`, `ask_bot`, `check_on_bot`, `list_tasks`, `add_task`, `update_task`, `create_group`, `post_to_group`, `show_weather`, `post_to_chat`, `ask_user`, `stay_silent`, `end_call`. Each tool's parameters are a zod schema, advertised as its JSON schema and checked on every call |
| Memory | `engine-memory.ts` | Reads the bot's memory files in its Hermes home, shows their entries in the app and removes one when asked. See [Memory](#memory) |
| Displays | `displays.ts` | Starts and stops each bot's X display (Xvnc, a D-Bus session bus, xfwm4) and takes screenshots with ImageMagick |
| Screens | `computer.ts`, `desk.ts`, `box.ts`, `machine.ts`, `server/box/*` | Screen leases, dressing a screen as the bot's computer, the bot's Chrome, the home screen. `server/box/machine.json` has the paths, ports and display numbers, read by both `machine.ts` and the box scripts |
| Viewer | `vnc.ts` | WebSocket relay between noVNC in the browser and the display's VNC server. Watching drops the browser's input at the relay; Take control and Stop switch the open connection (`POST /api/bots/:id/screen/mode`, naming the connection the browser opened) rather than reconnecting |
| Scheduling | `routines.ts`, `proactive.ts` | Cron routines and check-ins for each workspace's primary bot. Each run is a turn; a routine run adds nothing to the chat beyond what the bot writes. A routine whose last run is still going or waiting skips a run, so one can't stack turns ahead of the user's messages. `DISPATCH_NO_SCHEDULER=1` turns both off |
| Workspaces | `workspaces.ts`, `routes-workspaces.ts`, `bots.ts` | Separate teams of bots under the one account, each with its own primary bot, task board and check-ins. See [Workspaces](#workspaces-keep-teams-apart) |
| The team | `agent/team.ts`, `agent/asks.ts`, `routes-tasks.ts` | The task board, what each agent hears when the team changes, and one bot asking another a question. See [Bots work together](#bots-work-together-through-the-app) |
| Group chats | `agent/rooms.ts` | A room is a bot row with a member list; posts go to its members' queues. It has no turns, skills, memory or routines of its own, so its settings show only General. Its About and Instructions go into each member's app instructions under the group's name |
| Voice | `voice.ts`, `voice-relay.ts`, `speech.ts`, `web/src/voice/*` | Voice calls through a relay on the speech service and the bot's own agent, voice previews, composer dictation, call records with summaries |
| Speech service | `speech/` (its own container) | Text-to-speech (Phonon 31M), dictation and call transcripts (Parakeet Unified, Nemotron streaming, Silero VAD) over HTTP and a WebSocket at `SPEECH_URL`. `speech/README.md` has the API |
| UI | `web/src` | React and zustand: a sign-in screen, a rail of bot icons that opens into a full sidebar (a workspace switcher, names, previews, hidden bots), chat with a live "thinking" line, details panel (activity, tasks, computer, Library, an in-place look editor), the task board, a preview for Library files and chat attachments (next row), cards (approvals, questions, weather), voice call bar with captions, settings, viewer |
| File preview | `FilePreview.tsx` | Pictures, PDFs, audio and video sent in place by `files/raw?inline=1` for the types in `INLINE_TYPES`, and text and Markdown read here, the first 512 KB of a long file through a byte range. HTML shows as source and SVG as a picture from a data: URL, so neither runs script at the app's address, even opened in a tab of its own |
| On a phone | `lib/longPress.ts`, `lib/viewport.ts`, `public/manifest.webmanifest` | The sidebar as a drawer, dialogs as sheets, a hold for what a mouse does with hover and right-click (`lib/longPress.ts`), and the app kept as tall as what the keyboard leaves visible (`lib/viewport.ts`); `public/manifest.webmanifest` and the icons make it a home-screen app |

## Every bot is a Hermes home that Dispatch manages

Each bot, the primary one included, has a Hermes home at `~/dispatch/engines/<botId>` in the bots' account's home and its own `hermes gateway run --no-supervise` on 127.0.0.1 from port 8650 up. The gateway runs as the systemd unit `dispatch-gateway@<botId>.service` with the environment the server writes to `/run/dispatch/gateway-<botId>.env`. Its log is the journal: `journalctl -u 'dispatch-gateway@<botId>'`.

systemd restarts the gateway when it crashes, and it outlives a server restart, so a deploy leaves the bots working. The next server refreshes the home and keeps the gateway if its unit runs, its API key still works and the settings hash it started with still matches; otherwise it restarts the unit. A gateway whose bot's screen is down at that moment stays as it is, because a restart would only take its computer away.

The hash (`dispatch-settings` in the home) covers:

- the config keys Dispatch owns (but the default model),
- the `.env` it writes,
- the Hermes pin that `provision.sh` records in `/opt/hermes/.dispatch-pin`,
- the names of the app's MCP tools, which Hermes lists when it connects.

A home is a Hermes root of its own rather than a profile under a shared root, because Hermes v0.23 folds every profile into one multiplexing gateway, which would mean one process and one `DISPLAY` for all bots. Hermes is installed once on the machine under `/opt/hermes`, and each home links `tools/`, `installs/` and `plugins/github-copilot` back to it. `/usr/local/bin/hermes` is a copy of the launcher, because Hermes rewrites the checkout's own launcher to point at whichever home ran it last.

### What a home holds

`writeHome` builds or refreshes a home before each gateway start:

- `config.yaml` is created once. A new bot copies the primary bot's model, provider, auxiliary and fallback settings. After that Dispatch only rewrites the keys it owns, on every start:
  - the toolsets for the API server and for Hermes cron, and `agent.disabled_toolsets` (image generation, text to speech and Nous' connectors);
  - the SearXNG search backend;
  - the default model, and Dispatch's two endpoints under `providers:` (below);
  - the terminal's working folder (the bot's Library);
  - the bot's Chrome as `browser.cdp_url`;
  - `mcp_servers.dispatch` with the bot's token;
  - `timezone` from the server's `TZ`;
  - switches that keep Hermes off other cloud services (Nous guest tier, connectors, telemetry, update, catalog and plugin checks, speech recognition, language server downloads).

  The approval keys (`approvals.mode`, `approvals.deny`, `command_allowlist`) are written too, but kept out of the settings hash, since Hermes reads them again whenever the file changes (see Approvals below).
- The default model is the bot's chosen provider and model. Hermes resolves the default's credentials before it applies the provider a run asks for, so a default nobody has a key for would fail every run; Hermes' own cron jobs run on it too. With nothing chosen it is `deepseek-flash` when a DeepSeek key is set, unless a model was chosen in Hermes itself. Choosing a model rewrites it at once (`syncModel`); Hermes reads the file again, so it is kept out of the settings hash.
- `.env` holds the API server's key, port and host, the model credentials, `BROWSER_CDP_URL` and `SEARXNG_URL`. A credential set in Settings > Providers wins; one that isn't stays as the home has it (an older bot's own Copilot sign-in wrote its token there) or comes from the primary bot's home. Keys added by hand stay.
- `auth.json` holds the bot's own ChatGPT and Grok sign-ins (`signin.ts`), and a new bot starts without one. Copying the primary bot's would give two bots one refresh token, which a provider that rotates it on every refresh turns into a sign-out for whichever bot refreshes second.

  Claude has no sign-in: it runs on the token from `claude setup-token` in Settings > Providers (`CLAUDE_CODE_OAUTH_TOKEN`), which every bot shares, as it does Copilot's `COPILOT_GITHUB_TOKEN`. A Claude sign-in an older bot still has in `auth.json` comes first, and the token when that one fails.
- `SOUL.md` is the persona, written from the bot's name, role and description.

The gateway's environment has only `PATH`, `HOME`, `USER`, `LANG`, `TZ`, `HERMES_HOME`, its lock folder, `BH_HOME` and the bot's `DISPLAY`, none of the server's secrets. `BH_HOME` gives each gateway its own browser helper; with the default every bot would drive the same browser.

### Providers

The Engine section lists the providers in `PROVIDERS` (`engine.ts`), under their Hermes ids:

| Provider | Hermes id | Credential |
|---|---|---|
| Claude subscription | `anthropic` | `CLAUDE_CODE_OAUTH_TOKEN` for every bot, from `claude setup-token` |
| ChatGPT subscription | `openai-codex` | Sign-in with a code, per bot |
| Grok subscription | `xai-oauth` | Sign-in with a code, per bot |
| GitHub Copilot | `copilot` | `COPILOT_GITHUB_TOKEN` for every bot, from a GitHub sign-in with a code or pasted |
| Anthropic API | `anthropic-api` | `DISPATCH_ANTHROPIC_API_KEY`, through an endpoint Dispatch declares |
| OpenAI API | `openai-api` | `OPENAI_API_KEY` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` |
| xAI API | `xai` | `XAI_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` |
| Self-hosted | `self-hosted` | `DISPATCH_SELF_HOSTED_API_KEY`, if set, through an endpoint Dispatch declares |

The two endpoints are Hermes named custom providers in `config.yaml`'s `providers:`, present while their key or address is set:

- `anthropic-api` points at `https://api.anthropic.com` with the `anthropic_messages` transport. It exists because Hermes would use an `ANTHROPIC_API_KEY` for the `anthropic` provider too, ahead of a bot's Claude sign-in, which would move every subscription bot onto paid API use.
- `self-hosted` points at the address set in Settings, an OpenAI-compatible server.

Hermes asks only the current provider's endpoint for its models, so Dispatch asks both endpoints itself (`endpointModels`, kept for a minute) and offers what they list.

Whether a provider is connected comes from Hermes' own `/api/model/options`. Signing in happens with a link and a code, with nothing on the bot's screen (below).

### Subscription sign-ins

ChatGPT, Grok and Copilot sign in with the OAuth device flow (`signin.ts`): a link and a short code the user approves on any device, while the sign-in asks every few seconds.

- ChatGPT and Grok run `hermes auth add <provider>` for the bot's home in the background, with no terminal. The link and code are read from its output, and Hermes saves the sign-in to that home's `auth.json`.
- Copilot's is GitHub's device flow, run by the server with the github-copilot plugin's OAuth app. GitHub's token doesn't rotate, so it becomes the Copilot token in Settings > Providers for every bot.

`POST /api/bots/:id/engine/login` and `POST /api/providers/copilot/login` answer with the link and code, `GET /api/signins/:id` says how it went, and `DELETE` cancels it. One runs per bot and one for Copilot; sign-ins live in memory.

### When provider settings change

A gateway loads its home's `.env` into its environment when it starts, and falls back to that copy when the file loses a key. So a change in Settings > Providers restarts every gateway (`refreshEngines`): at once if no run uses it, otherwise when the last one ends.

Every chat turn, voice reply and call summary holds its gateway while its run lasts (`holdGateway`), so the restart never cuts one short; Hermes' own cron jobs can't be seen and may be. A settings version read with the secrets tells whether a gateway runs on the newest, so settings saved while it was starting get a start of their own.

A secret taken out of Settings also leaves every home that still holds that same value, so a bot's own sign-in stays. The first start of this version copies the provider variables still in the server's environment into `settings` once (`importEnvironment`).

### Memory

`engine-memory.ts` reads `memories/USER.md` (what the bot knows about the user) and `memories/MEMORY.md` (its own notes) in the bot's Hermes home. The app shows the entries as "About you" and "Notes" and removes one when asked, holding the lock Hermes' memory tool writes under (an flock on `<file>.lock`, taken through util-linux `flock`) and replacing the file whole.

Hermes reads both when a conversation starts, so a removal shows from the next conversation on. The server looks at the files every 3 seconds and sends a `memories` event when they change, so an open Memories tab shows what the bot saves.

## Each bot has its own screen and Chrome

### Every bot runs as one ordinary account

The bots share one account on the machine (`account.ts`): `DISPATCH_USER`, which the installer sets to the account that ran it. Nothing starts without it (the server, the box scripts, `install-units.sh`). It is root only when it says `root`, since root's bots run Chrome without its sandbox, and `deploy.sh` replaces `/etc/dispatch/env` whole, so a lost line mustn't make them root without a word.

`scripts/install-units.sh`:

- gives every bot unit a drop-in (`account.conf`) that runs it as that account with its home,
- lets the account sudo without a password (`/etc/sudoers.d/dispatch`, checked with `visudo` before it goes in),
- gives it the Hermes install under `/opt/hermes`, where Hermes writes as it runs.

So a bot has no root shell, but can still install what it needs; and since every bot is the same account, a file one bot makes is one every other bot can open and change.

The server stays root: it starts the units, writes Chrome's policies, and keeps `DATA_DIR` (the database, the secret, the setup code) at 0700, out of the bots' reach without sudo.

- What it writes into the bots' folders (a home's `config.yaml` and `.env`, Library files, Chrome preferences) it hands to the account (`own`, `mkdirOwned` in `account.ts`, `own` and `write_owned` in `dispatchlib.py`).
- What it runs in a home (a Hermes sign-in) it runs as the account with `setpriv`.
- Everything the bots use is under `~/dispatch` in the account's home (`machine.ts`, from `server/box/machine.json`'s `botsDir`).

The dock and the home-screen server are Dispatch's own and stay root, because they ask systemd to start apps in a bot's slice; what they start runs as the account. A screen's session bus answers its own account only, so everything that uses it (the window manager, terminals, apps) runs as the account too.

Chrome keeps its sandbox: it runs as the account, and Google's package brings the AppArmor profile and setuid helper it needs on Ubuntu 24.04 and later.

### Displays, slices and the dock

`displays.ts` runs one X display per bot: `:99` for the primary bot and the lowest free number from `:100` for the others. Each display is three systemd units under `dispatch-display@N.target`, in `dispatch-displays.slice`:

- `dispatch-xvnc@N`: TigerVNC's `Xvnc` at 1440x900 with its VNC server on 127.0.0.1:5900+N and no VNC password;
- `dispatch-bus@N`: a D-Bus session bus at `/run/dispatch/display-N/bus`;
- `dispatch-wm@N`: `xfwm4 --compositor=off`.

systemd brings back a piece that crashes, and the window manager waits for a new X server. A display stops only when its bot is deleted. A lease in the `screens` table outlives the server, and on start the server brings back every leased screen with its dressing.

Everything else a bot runs is in its own slice, `dispatch-bot-<botId>.slice` (the id escaped as `systemd-escape` does it):

- its gateway;
- its Chrome (`dispatch-chrome-<botId>.service`);
- its dock (`dispatch-shell-N.service`);
- every terminal, file manager and app opened on its screen (`dispatch-term|files|app-N-<ms>.scope`).

The slice's limits:

- `MemoryMax` is the machine's memory less 2 GiB, split by `MAX_BOTS`, at least 768 MiB;
- `MemoryHigh` is at 85% of it;
- at most half as much again in swap (`MemorySwapMax`);
- `CPUWeight=50`.

So a bot that runs away loses a process of its own, never another bot's or the server's.

The home-screen server (`dispatch-home.service`) and the desk's jobs (`dispatch-job-*.scope`) are in `dispatch.slice`, which holds all of these. None of it runs in `dispatch.service`, so restarting the server leaves the bots' screens, Chromes and agents running.

### Dressing a screen

`desk.ts` makes a screen look like the bot's own computer. It runs `dispatch-screen.py` from the release's `server/box/`, one command per action, each answering with one JSON object; work that takes longer goes on in a job of its own, which writes its result to a file the server reads. A script that is missing or crashes is an error with its traceback, never a reason to set anything up again. The scripts keep what they make under `/opt/dispatch`.

One-time setup, again whenever the scripts change, starts the home-screen server (`dispatch-home.py` on port 7391):

- Each bot's Chrome reaches it as `home.localhost`, which a `--host-resolver-rules` rule sends to the screen's own loopback address (127.1.x.y) where the server listens for that screen alone, so where a request arrived says whose page it gets.
- Any other Chrome resolves `home.localhost` to 127.0.0.1 and gets a plain page; the page asked for by 127.0.0.1, as an extension packed before this did, is sent on to `home.localhost`.
- It answers only requests that name it as `home.localhost` or 127.0.0.1, so a web page that points its own name at it gets nothing.

Setup also writes a Chrome policy that installs the home-screen extension; the extension's signing key stays root's, in `/opt/dispatch/home-extension.pem`.

Dressing a screen sets a wallpaper in the bot's colour, a dock, a light theme, and starts Chrome as the bots' account with the profile `~/dispatch/profiles/<botId>`, DevTools on port 9200+N, maximized on the home screen. A stamp on disk records what was applied, so a repeat call costs one short script run.

Before each turn, `screenForWork` leases and dresses the screen and checks that its Chrome answers on DevTools, dressing it again if not, so the agent finds its browser instead of starting one of its own. A screen that cannot be readied is logged and the turn goes on without it. Hermes' browser tool uses that Chrome through `browser.cdp_url`, so everything it does shows in the viewer.

### Chrome updates

Chrome's security updates come from apt: `provision.sh` has unattended-upgrades take Google's repository as well as the distribution's. A running Chrome keeps its version, so every hour `chrome-updates.ts` compares the version in dpkg's status file with what each bot's Chrome reports at `/json/version`.

It starts a Chrome that is behind again (`restartChrome`, which dresses the screen with Chrome restarted) once its bot has no turn running, no call, and nobody on its screen in the viewer. A busy bot waits for the next check.

### The viewer

The viewer relay (`vnc.ts`) checks the browser's session cookie, does the RFB handshake with Xvnc itself, then offers the browser an unauthenticated RFB session. In watch mode it drops key, pointer and clipboard messages on the server. When the user hands the screen back after taking control, the bot's next turn starts with a note to look at the screen before relying on it. Resetting a screen closes every window and brings Chrome back to the home screen; logins stay.

Hermes can also run a private "Bot Desktop" for a home. While it runs, that agent's computer-use tool acts there and not on the screen the app shows, so the Engine section reports it and offers to stop it.

## The transcript is a list of rows

A conversation is an append-mostly list of rows: `seq` (position), `updatedSeq` (a per-bot revision counter), `kind` and a JSON `body`. A streaming reply is the same row rewritten with a higher `updatedSeq`, so clients upsert by `seq`.

A per-bot `generation` counter starts a new conversation ("New chat"), and with it a new Hermes session (`dispatch-<botId>-g<generation>`). Rows of earlier generations stay in the database, unseen, and a row is addressed by bot, generation and seq (`RowRef` in `store.ts`).

Work that outlives a request, such as a turn, its app tools or the sweep of abandoned voice calls, writes through a `Conversation`: once the user starts a new chat its appends are dropped and its updates land on its own rows, so nothing of an old chat shows in the new one. A call's end record is written by the request the browser sends at hang-up, into the bot's current chat.

Row kinds:

- `message`: from the user, the bot, another bot or a voice call; a `note` is the bot thinking aloud, kept but hidden.
- `tool-call`: an activity line and a step in the collapsible list.
- `card`: approval, question, weather. A question card goes from pending to answered once.
- `event` and `notice`.

`agent/transcript.ts` decides what a turn's text becomes. Text is held until it is clear whether a tool call follows it: then it is a note, and the status line shows its first sentence; otherwise it is a message. A turn that wrote only notes answers with its last one. `test/turn.test.ts` replays scripted Hermes runs to pin this.

What a bot is doing now (`agent/live.ts`) is idle or running, with an activity, a start time and a caption from its reasoning. It is kept in memory and sent on the event stream.

### The turn runner

A bot's runner (`agent/turns.ts`) runs one turn at a time.

- Stop ends the running turn and asks Hermes to stop its run, and lets queued ones run.
- New chat and deleting the bot also drop the queue, and a turn queued before a New chat is skipped.

The queue is kept in `turns` and every unfinished Hermes run in `runs`, because a restart (every deploy and update) leaves the gateways running. At startup:

- runs nobody follows any more are stopped;
- queued turns run again;
- a turn that was running is closed off in its chat, with its answer if Hermes finished it meanwhile and otherwise a notice that it was interrupted.

### A turn is a Hermes run

A turn is a Hermes run (`POST /v1/runs`, then `GET /v1/runs/<id>/events`) on the conversation's session. `agent/runs.ts` starts, follows and stops every run, a chat turn's, a voice reply's and a call summary's, so all three read a run's end the same way:

- A run Hermes cancels or interrupts on its own is a failure, not an answer.
- So is one whose events stop with no end event (what a gateway killed for running out of memory leaves), unless Hermes' record of the run (`GET /v1/runs/<id>`) says it completed; a run still going then is stopped.

A run's events carry text deltas, commentary, tool starts and ends with an error flag, reasoning, approval prompts and the final answer. Unlike the Responses stream used before, they carry no tool arguments or full results, so a tool row has a status but rarely a reason, and an app tool's arguments come from its MCP call.

Chats from before runs kept their history in a Responses conversation, which a run can't continue: the first run of such a chat (its session doesn't exist yet and the bot has answered in it) starts with a recap of the messages the chat shows.

Right after a gateway starts (or this server does), the bot's first run goes alone until Hermes begins answering it, at most 30 s (`runSlot` in `engine.ts`). Hermes loads a provider's SDK on first use without a lock, and a chat turn and a voice reply that load the Anthropic SDK at the same moment could fail one of them.

The model's own history is Hermes' business; the app keeps only what it shows.

## Hermes asks before risky actions, in the chat

Settings > Permissions sets how every bot's Hermes asks before an action it flags as risky, such as a command that matches its dangerous patterns or a write to `~/.ssh/config`:

- Off: it never asks.
- Smart: Hermes' auxiliary model clears low-risk actions and asks about the rest.
- Ask (`manual`): it always asks.

The choice is `users.approval_mode`, which starts on Smart. `engine.ts` writes it into every bot's `config.yaml` as `approvals.mode`, with `approvals.deny` ("Never Allow": glob patterns of terminal commands Hermes refuses in every mode, from `users.approval_deny`) and `command_allowlist` ("Allow without Asking"). Hermes reads these again when the file changes, so a change applies to running gateways at once.

When Hermes asks, the run sends `approval.request` and waits, for up to its 5-minute timeout. A chat turn or a voice call hands the prompt to `agent/approvals.ts`, which adds an approval card to the bot's chat and a row in `approvals`, and the tool's row waits with it.

The card shows Hermes' description and the command, with the answers Hermes offers: Allow (`once`), Always allow and Don't allow. The answer goes to `POST /v1/runs/<id>/approval` with Hermes' prompt id and the run's execution generation, and the run carries on.

Hermes saves an "Always allow" into the asking bot's `command_allowlist`; Dispatch then gives every bot the union, and removing an entry in Settings takes it from all of them.

A prompt that ends without an answer (Hermes' timeout, Stop, a call hanging up) expires its card: after each later event of a run with an open prompt, Dispatch checks the run's `pending_controls`, and the run's end expires whatever is left.

Pending prompts live in memory beside their runs, so one left by a process that stopped expires at startup. Hermes' hard blocks, such as credential files, apply in every mode, and the app's own MCP tools never ask.

## Bots work together through the app

The bots are a team, each with a role, and work together like colleagues at a small company.

- Every bot's app instructions (`agent/prompt.ts`) list its teammates with their roles, their About and where their Libraries are, and say how the team works. Nothing there changes as the team works, so the prompt cache holds; what does change (tasks, what a teammate is doing) reaches a bot through its tools or as news at the start of a turn.
- `ask_bot` asks a teammate a question and hands back the answer in the same turn (`agent/asks.ts`).
  - The answer is a Hermes run on the teammate's gateway, in a side conversation for that pair of bots (`dispatch-<to>-ask-<from>-g<generation>`), like a voice call's. It doesn't wait behind the teammate's turns, and two bots asking each other at once can't wait on each other.
  - Before each question the side conversation hears what the teammate is doing, its open tasks and what is new in its chat (the recent messages, the first time).
  - The question and its answer are a row in both chats, shown as a line that opens to both. The teammate's chat hears what it answered at its next turn (`catchup.ts`), so it knows what it told whom.
  - A bot answering a question may ask one more teammate, and no further. A question gets 10 minutes, ends when the asker's turn is stopped, and ends when either bot is deleted.
- `check_on_bot` shows where a teammate stands: its role, instructions, skills, routines, tasks, what it is doing now, its own notes and its latest messages. The teammate isn't told.
- The task board (`agent/team.ts`) is shared by the team and the user. A task is to do, doing, blocked or done, and belongs to one bot or to nobody.
  - Bots use `list_tasks`, `add_task` and `update_task`; the user uses the board in the app (`/api/tasks`), opened from the sidebar or a bot's details, where a bot's own open tasks are listed too.
  - Giving a bot a task (a new one, or moving one to it) tells it, puts a line in its chat, and wakes it with a 'team' turn so it starts on it. Only one wake-up waits in its queue at a time, and one whose news an earlier turn already told is skipped.
  - The owner hears what someone else changed, the old owner hears a task moved away, and the bot that created a task hears when it's done.
- The team log (`team_log`) is what each bot hears about the team: those task changes, and a teammate joining or leaving. A bot hears the entries it hasn't heard yet as a `[Team news]` note at the start of its next turn; a new bot starts caught up.
- Deleting a bot hands its open tasks back to nobody, saying whose they were (a task it was doing is to do again), and the rest of the team hears it left and which tasks wait for someone.
- `send_to_bot` puts a message from one bot into another bot's queue, and the reply comes back the same way.
- Every message, wake-up and task between bots carries the number of hops behind it. After six the tools stop waking bots and tell the bot to answer the user.
- A group chat is a bot row with `kind='room'` and a member list.
  - A user message goes to the @mentioned members, or to all of them, at most three; each one answers with `post_to_group` or stays silent.
  - Files attached in a group are uploaded to the group's own folder (`files/<roomId>/uploads`), which its chat shows them from. Sending the message copies them into every member's Library under `uploads/` (`library.ts`, numbered when the name is taken), and the members asked to answer are told where their copies are.
  - A group has no voice calls.
  - The group's About and Instructions reach its members through their app instructions (`agent/prompt.ts`), not through each group message, so they don't pile up in every member's history; its label is only shown in the app.
- For work inside one task, Hermes' own delegation (the `delegation` toolset) is used.
- Each workspace's primary bot gets check-ins at the times set in the workspace's settings or with `set_checkins`, and sends one short message or calls `stay_silent`. It is told the workspace's pending approvals, the routines that ran, its teammates and what on the board is blocked or has nobody. A check-in is skipped when the user sent one of the workspace's bots a message in the last 20 minutes; Settings' "Check In" runs one at once. A primary bot's first greeting mentions check-ins once, since nothing else in a chat says it can write first.

## Workspaces keep teams apart

A workspace (`workspaces.ts`) is a separate team of bots under the one account, like the workspaces of a chat app: work and personal, say.

- Each has its own bots and group chats, one primary bot, a task board and check-ins. Provider settings, approvals and the computer are shared.
- A bot knows of and reaches only its own workspace's bots. The roster in its instructions, `send_to_bot`, `ask_bot`, `check_on_bot`, the task tools, `create_group` and `post_to_group` all look in `bots.workspace_id`, and a group chat's members come from its workspace. The instructions name the workspace once the user has more than one.
- This keeps the teams apart in the app, not on the disk: every bot runs as the one account, so a bot with a shell could still read another workspace's files.
- Every account starts with one, Personal (`ensureOwner`, or migration 5 for an account from before). `POST /api/workspaces` makes another together with its first bot, which becomes its primary bot and greets the user, so no workspace is without one. The last workspace can't be deleted; deleting another deletes each of its bots as `deleteBot` does, then its board, news and check-ins.
- A workspace can turn its board off. Its bots are then offered no task tools: `tools/list` (`toolsFor`) leaves them out, the settings hash covers the names a bot is offered, and each of the workspace's gateways restarts on the new list once no run holds it (`refreshTools`). Their instructions stop mentioning the board, the app hides it, and its tasks wait for it to come back on.
- Moving a bot to another workspace (`moveBot`) takes it off its team as deleting it would (its tasks go back to nobody, the others hear it left), takes it out of its group chats, and has it join the new team caught up. Questions to or from it end. A primary bot can't move until another bot is made primary.
- The web app shows one workspace at a time: the selected bot's. The sidebar, Search, the board and new bots and groups are that workspace's, and switching opens the bot last open there, or its primary bot.

## A voice call is the bot's own agent behind a speech relay

Each thing the user says on a call is a turn of the bot's Hermes agent, on the bot's model and with all its tools.

`POST /api/voice/session`:

1. writes the call's start row;
2. wakes the bot's gateway and screen;
3. fixes the call's instructions: the app's usual instructions, then a call section (talk instead of writing and post what is better read with `post_to_chat`, the local time, what the bot is doing in its text chat, and the last 14 chat messages);
4. picks a greeting;
5. returns the relay's path, `/api/voice/relay/<callId>`.

It answers 503 when the speech service is down. The browser opens the path on its own origin with `ws:` or `wss:` to match the page. Like the viewer, the relay accepts the session cookie, and it takes one socket per call.

The browser (`web/src/voice/call.ts`) speaks a subset of OpenAI's Realtime events, and the relay (`voice-relay.ts`) answers it:

- The microphone's PCM (16-bit mono, 24 kHz, 40 ms frames, resampled in an AudioWorklet from the context's rate) goes to the speech service's recognition socket, through the call's own echo canceller and gate ([below](#the-call-cancels-the-bots-echo-itself)).

  The socket's `speech_started` and `speech_stopped` become `input_audio_buffer.speech_started` and `.speech_stopped`, each `partial` becomes `conversation.item.input_audio_transcription.updated` with the transcript so far, `final` becomes `.completed`, and `speech_dropped` becomes `conversation.item.deleted`. Muting sends `reset`.
- The browser's first `response.create` gets the canned greeting, spoken at once. The first turn is told what it was.
- Each final transcript with words in it starts a Hermes run (`POST /v1/runs`) on the call's own session, `dispatch-<botId>-<callId>`, with the call's instructions, the bot's model and provider and its reasoning effort. The relay follows the run's events (`GET /v1/runs/<id>/events`). Runs can be stopped and steered and carry Hermes' approval prompts, which is why chat turns use them too.
- `message.delta` text is cut into sentences, and the speech service speaks them one after another in the bot's voice and speed. Text before a tool call is spoken when the tool starts. The audio goes out as `response.output_audio.delta`, each sentence as a transcript delta, between `response.created` and `response.done`.
- With AEC3 the browser plays the bot's audio and the thinking loop straight from the AudioContext. With the browser's canceller instead, it plays them through a WebRTC connection between two peer connections in the page, from an audio element (`CallOutput` in `web/src/voice/audio.ts`), since a browser's canceller subtracts only the audio it knows is the far end of a call (Chrome's does then; Safari's didn't).

  The connection adds about 40 ms. If it doesn't connect within three seconds, or drops mid-call, the call plays straight from the AudioContext; the server's log of the call's end says which way it played.
- Each `tool.started` sends `dispatch.activity` with its label ("Running commands") for the call bar. While a reply is in progress and no audio is playing, the browser plays a quiet loop made with Web Audio (`ThinkingLoop` in `audio.ts`), after 350 ms of quiet; it fades out when audio starts.
- `end_call` is one of the app's MCP tools. When the run starts it, the relay speaks what came before, sends `dispatch.hangup` and stops the run; the browser hangs up once its audio has played.
- A Hermes approval prompt (`approval.request`) becomes a card in the bot's chat, as in a text turn, and the call bar says "Waiting for you in the chat" until it is answered there. The reply waits meanwhile, for up to Hermes' timeout.

### The call cancels the bot's echo itself

The call cancels the bot's echo itself, as a native call app does. Browsers' own cancellers let the bot's voice reach the microphone at −8 to −12 dB with desk speakers in Safari and Firefox, whether it played from an AudioContext or through WebRTC, and the recognizer heard it as the user talking over the bot.

So the microphone is opened with the browser's echo cancellation, noise suppression and gain control off, and WebRTC's AEC3, compiled to WebAssembly (`web/src/voice/aec.ts`, `@ennuicastr/webrtcaec3.js`, loaded when a call starts), subtracts what the call plays. The capture worklet takes the call's sound as a second input, on the same AudioContext clock as the microphone, and AEC3 gives the microphone back at 24 kHz about 10 ms later.

If AEC3 can't load or start, the browser's canceller is used, and the bot plays through WebRTC (above).

Firefox won't connect a microphone to a context at another sample rate (Mozilla bug 1674892), so then the browser captures in a context of its own at a rate it accepts. When Firefox can't capture the microphone in the call's context (another rate), the call moves its playback to the microphone's context before it connects. A microphone that sends no frames for three seconds ends the call with a message.

After the canceller, while the bot is audible, each frame goes through an echo gate (`web/src/voice/echo.ts`) for what is left:

- The gate sends a frame only if it is more than 2.5 times as loud as the bot's voice at the microphone, and silence in its place otherwise.
- A frame that goes out keeps the gate open for 480 ms, and once the relay pauses the bot everything goes out again.
- How loud the bot is at the microphone is learned during the call, as the ratio of microphone to output energy while the bot makes sound (from the player's AnalyserNode). Each frame is counted at most as loud as the gate's limit, so that talking over the bot barely moves it.

The call's end sends what the canceller and the gate did, and the server logs it with the browser's name. With AEC3 it also sends the call second by second while the bot was audible (`web/src/voice/echo-log.ts`, logged on a second line):

- what played, what the microphone heard and what AEC3 left;
- the echo's delay (the lag at which the microphone's 1 ms envelope best matches what played);
- render quanta that brought no microphone audio;
- the context's output latency.

So a moment where the bot's voice got through shows whether the room got louder, the delay moved or the microphone dropped audio.

### Talking over the bot

The speech service ends an utterance after 500 ms of silence. When the user starts talking, the browser pauses the bot's audio, keeping what it hasn't played, and the relay starts no new sentence. The final transcript decides what that was, and the relay tells the browser with `dispatch.playback`.

With no words (a cough, a noise, the bot's own voice coming back through the microphone, or the microphone muted mid-utterance) the bot plays on from where it paused. Over the bot's speech, these finals don't count as words either:

- A final that names the streaming model: Parakeet found none in it, and the stream's guess at a short sound is how noise had become "That's" and cut the bot off.
- A final whose words are, in order, the end of what the bot was saying (the sentence playing at the pause and the one before it, one word in four allowed to differ): with speakers and a microphone in the same room, some of the bot's voice gets past the echo canceller and the recognizer writes it down.
- A final of at most three words that only acknowledge the bot ("yeah", "mm-hmm", "okay", "right"; `isAck`): that isn't the user taking a turn, and a scrap of the bot's voice that got past the canceller had come out as "Yeah." and cut it off. It does count when the pause came in the last sentence of a finished reply and that sentence asks something, since then "yeah" is an answer.

With words, the browser drops the audio it holds, and:

- If a tool call is running, they go to the run with `POST /v1/runs/<id>/steer`. Hermes hands them to the agent when the tool batch ends, before its next model call, and the same turn answers. A steer sent while the model is writing could miss that point and land after the turn, which is why only a running tool gets one.
- Otherwise the run is stopped (`POST /v1/runs/<id>/stop`, about 0.15 s) and a new one answers. A stopped run keeps the user's words and its finished tool calls in the session's history; a run stopped while still queued doesn't, so its words go into the new run's input.
- The relay mirrors the browser player's schedule. When the user talks over a reply, the next turn starts with a note saying how much of it they heard, because the agent's history keeps everything it wrote.

### When the call ends

When the call ends, a run still going is stopped. The browser posts its transcript to `POST /api/voice/end`, which writes the end row; a call the server lost in a restart is found by its start row.

The bot's own agent then adds a title and a one-sentence summary to that row: one short Hermes run, on the model the call used, on a session of its own beside the call's (`<call session>-summary`), given the transcript. Hermes holds the bot's model access, so any provider works.

### A call and the text chat tell each other what they missed

A call's conversation in Hermes is apart from the chat's, so that a call answers at once while a chat turn works, and its turns don't carry the chat's whole history. The chat's rows are the record of both, and `agent/catchup.ts` tells each conversation the rows it did not write, as a bracketed note at the start of a run's input (the instructions, and the prompt cache behind them, stay the same):

- Each run on a call starts with what is new in the text chat since the call's last run: messages typed there, the bot's finished replies there, questions waiting for an answer, the app's notices. The call follows the bot's row revision rather than seq, because a reply is rewritten as it streams and a note can become a turn's answer at its end; a row is told once, when it is finished. A run stopped before Hermes started it asks again with its notes as well as its words.
- A chat turn starts with the calls that ended since the chat's last turn, each with its transcript, and what a call posted in the chat. `bots.told_seq` is how far into the current chat its agent has been told; a turn moves it once Hermes has accepted the request, so a turn that never reached Hermes leaves the news for the next one, and New chat starts it again at 0.
- `post_to_chat` puts a bot message in the chat, for what is better read than heard. An app tool call that no chat turn claimed, made while the bot is on a call (`liveCallOf` in `voice.ts`), is the call's, and the message carries the call's id: the call isn't told its own posts, and the chat's next turn is.

A call's tool calls don't appear as steps in the text chat (what it posts with `post_to_chat` does), and a call can run while a chat turn runs. Both share the bot's screen and Chrome.

An app tool call reports its outcome into a chat turn, or ends it (`ask_user`, `stay_silent`), only if it claimed one of that turn's tool rows (`claimToolRow` in `agent/turns.ts`). The MCP request names the bot but not the conversation, so a call's tool use can still claim a chat turn's row when both use the same tool at the same moment.

### Voices, previews and dictation

A bot stores a voice id and a speed (`speech.ts`): one of Phonon's 37 voices, which the picker groups as American, British and Characters. A voice the speech service doesn't list reads as its default, `harper`, and a speed is clamped to 0.86 to 1.27, on every read and write. New bots get one of six clear, even voices, picked by id.

Phonon drops dashes, so the speech service turns them into commas and stops first (`speech/app/text.py`). Voice previews stream the speech service's PCM through `POST /api/voice/preview`, and composer dictation sends the recording through `POST /api/voice/stt` to the speech service's Parakeet transcription.

### How fast a call answers

On the dev machine, with the primary bot on `deepseek-flash`, the answer's first audio came 2.4 s and 2.9 s after the end of the user's speech at the medians of two five-question runs (2.3 to 3.8 s): about 0.7 s for the final transcript, and most of the rest Hermes and the model before the first token. A steered question during an 8-second `sleep` was answered in the same turn. Speech over a reply pauses it 0.21 to 0.29 s after the user starts talking.

## Data lives in two places

| Production | Dev container | Holds |
|---|---|---|
| `/var/lib/dispatch` (`DATA_DIR`), root's alone | volume `data` at `/data` | `dispatch.db` (SQLite in WAL mode, schema in `db.ts`: the user and sessions, workspaces, bots, rows, approvals, routines, skills, tasks, screen leases, check-ins and settings), `secret` (signs the MCP tokens), `auth-fingerprint`, and `setup-code` while no account exists |
| `~/dispatch` in the bots' account's home | volume `home` at `/home/bots` | `engines/<botId>` (each bot's Hermes home), `profiles/<botId>` (Chrome profiles), `files/<botId>` (the Library, also the bot's working folder) |

Hermes (`/opt/hermes`) and the packages come from `provision.sh`, the box scripts run from the release and keep their state in `/opt/dispatch`, the units' logs go to the journal (`journalctl -u 'dispatch-*'`), and what the bots open on their screens logs to `/var/log/dispatch`. On the host all of it stays, along with whatever the bots install; in the dev container only the volumes survive a rebuild.

### Deleting a bot

Deleting a bot (`deleteBot` in `bots.ts`) goes in this order:

1. It removes its row first, so requests about it fail from then on.
2. It stops its turns, gateway and display, then its slice with anything of the bot's still running in it.
3. It deletes its home, Chrome profile and Library folder.
4. It frees its screen lease last.

A deleted group only has its folder of attached files to remove.

The row's delete also records the bot in `deleted_bots`, which keeps its gateway's port from new bots until the deletion is done. If the server stops first, it finishes the deletion when it starts again, and so it does for a screen lease whose bot is gone with no such record.

### Resetting Dispatch

Settings > General > Reset Dispatch (`reset.ts`, `POST /api/reset`, behind two confirmations):

1. deletes every bot the way deleting one does (above);
2. erases the rest of both places: every Hermes home, Chrome profile and Library folder, and in `DATA_DIR` the database with any old copies, `secret`, `auth-fingerprint` and `setup-code`;
3. writes the new install's setup code, which the reply already gave the browser, and exits.

Then systemd (`Restart=always`) or the container's restart policy starts it again as a fresh install, with no account; the web app waits for that and reloads into the first-run form with the code filled in. A new process leaves nothing of the old data in memory. The home-screen extension key, the logs, Hermes, the packages and whatever the bots installed stay.

### Backup and restore

`scripts/backup.sh` copies both places into one archive (`data/`, `bots/` and a `BACKUP` file naming the release and the account) without stopping anything:

- Every SQLite database among them, Dispatch's and each Hermes home's, goes through SQLite's backup (`server/dist/backup-db.js`, with the release's own Node), so a database in WAL mode is copied whole.
- The rest is copied as it is, without Chrome's caches and lock files, the packages uv keeps in each Hermes home (`cache/uv`), or `release.sh`'s copy of the database.

`scripts/restore.sh`:

1. stops `dispatch.service` and `dispatch.slice`;
2. moves both places aside;
3. unpacks the archive;
4. gives the bots' files to the account here;
5. starts the server, which brings the bots' units back.

### Time zone

The server runs on the time zone in `TZ` (UTC when unset), set in `/etc/dispatch/env` (written by the installer, or copied from `.env.prod` by every deploy), or in the dev container's `.env`; the host's clock stays on UTC. Displays, Chrome, terminals and gateways get `TZ` passed on, every Hermes config gets it as `timezone`, and routines and check-ins without a zone of their own use it.

## Signing in and first-run setup

### The account and its setup code

There is one account, on the owner's `users` row, which holds only a user name (also what the bots call the owner) and a scrypt hash of the password, both null on a fresh install (`lib/auth.ts`, `routes-auth.ts`). `GET /api/auth/me` says whether one exists; while none does, the web app shows the first-run form and `POST /api/auth/setup` creates it (once), with the setup code.

The setup code is a one-time code (`DATA_DIR/setup-code`, 0600, and the log) without which whoever reached Dispatch first on the network would make the account.

- The installer prints the address with it after `#setup=`, which the web app takes out of the address bar and keeps for the tab (`web/src/lib/setupCode.ts`), asking for it only when the page came without one.
- A wrong code counts as a wrong password, and making the account deletes it.
- `reset-account.ts` forgets the account from the command line and prints a new setup code.

### The setup wizard

A fresh install has no bot: after the account, `needsSetup` (the owner's `setup_at` is null) puts the setup wizard (`web/src/components/SetupWizard.tsx`) over the app. The wizard:

1. makes the first bot with `POST /api/bots` when its name and look are chosen, so the bot's screen and gateway start while the user writes its label, About and instructions;
2. connects a model through Settings > Providers or a sign-in with a code (`signin.ts`);
3. ends with `POST /api/setup/finish`, which has the bot greet the user if it has a model.

The first bot a user makes is the primary one of their first workspace, Personal, and a bot made during setup holds its greeting until then (`bots.ts`). Accounts from before the wizard are past it.

### Sessions

`POST /api/auth/login` gives a 30-day session cookie, `/logout` ends it, and `/password` changes the password and ends every other session. Ten wrong passwords from one address in 15 minutes shut it out for the rest of that window.

Every `/api` route needs the session except `/api/health`, those before one and the HTTPS certificate (`/api/https/certificate`); the web app's files and `/mcp/*` (bearer tokens) don't. A 401 carries no basic-auth challenge.

### Requests from other sites

A change to anything under `/api` (any method but GET, HEAD and OPTIONS), signing in included, and the screen and call WebSockets are refused with 403 when a browser sent them from another site's page, by its `Sec-Fetch-Site` or else an `Origin` that names another host (`crossSite`). The cookie is SameSite=Lax, which doesn't cover another port of the same address, and the API reads JSON whatever the Content-Type.

The cookie is Secure when the browser came over HTTPS, its own or a proxy's (`X-Forwarded-Proto`). Every answer has a Content-Security-Policy that runs only the app's own scripts (and a blob: worklet and WebAssembly for calls), lets only the app frame its pages, and sends no referrer (`app.ts`).

## HTTPS

With `HTTPS=1` (the installer sets it), Dispatch serves HTTPS on `PORT` with a certificate it signs itself (`https.ts`), since browsers allow the microphone only over HTTPS and no public authority signs one for a local address.

A certificate authority of the machine's own signs it, name-constrained to exactly the names the certificate holds: localhost, the host name and `<host>.local`, 127.0.0.1 and the address the machine reaches the network from. Both live in `DATA_DIR/https`, which a reset leaves alone. A new address gets a new authority and certificate, and a certificate near its end a new one from the same authority, checked at start and hourly.

The port reads each connection's first byte:

- A TLS handshake gets HTTPS.
- Plain HTTP from the machine itself is served as before (the health check, Tailscale Serve, the bots' MCP).
- Plain HTTP from elsewhere is redirected.

`GET /api/https/certificate` (open) is the authority for a device to trust, offered in Settings > General when the page came over it.

## Updates

Updates run only on a machine the installer set up: one running a release under `/srv/dispatch/releases` and with `/etc/dispatch/source`, where `install.sh` writes the repository and the branch it was told to follow, if any. A `deploy.sh` host has none.

A signed release says which version it is in a `VERSION` file the installer writes into its folder, so the version is a property of the release that runs, never of one that failed.

### Finding a newer release

A minute after starting and every six hours, the server (`updates.ts`) asks GitHub's API for the repository's releases. It offers the highest published `vX.Y.Z` with signed checksums attached when it is after the running release. `publish.sh` pushes a tag before GitHub Actions builds its release, so a tag alone isn't a release yet. On a branch, it offers the branch's newest commit when it isn't the running one.

### Installing it

Update (`POST /api/update`) runs the running release's own `scripts/install.sh` again, unattended, in a systemd unit of its own (`dispatch-update`) so it outlives the server. A failed unit leaves the old release running. The installer:

1. takes the highest `vX.Y.Z` tag whose signed checksums download from its release, passing over a draft still being built, or a tag with no release;
2. fetches that tag with git and runs nothing of it until `ssh-keygen` finds the tag signed by a key in its `release_signers`, so each release is checked against the keys of the one before it; it refuses a release older than the running one;
3. downloads the build GitHub Actions made of that tag (`.github/workflows/release.yml`, `scripts/build-release.sh`): a tarball with its own Node, and a manifest naming the commit and the speech image by digest, both listed in `SHA256SUMS`, which a release key signed too (`fetch_assets`).

A branch is downloaded as source, and `release.sh` builds it with the same script.

### Starting the new release, or going back

The new release's `release.sh`:

1. stops the service;
2. copies the database to `dispatch.db.before-update` (the new release migrates it as it starts, and the release before refuses a newer schema);
3. starts the service on the new release.

If `/api/health` doesn't name the new release's commit within a minute (it answers once the database can be read), `release.sh`:

1. puts the database back;
2. points `/srv/dispatch/current` back at the release before it;
3. starts that release's speech image again;
4. writes `/etc/dispatch/last-update` and fails.

The old release starts `failed`, saying which version didn't start, and removes the file.

### What the browser sees

While it runs, the server reads each step from the installer's log and sends `update` events. Each SSE `hello` names the running commit, and a page that saw an update start reloads when the commit changes.

## The model providers, SearXNG and Open-Meteo are the only services Dispatch needs

| Service | Used for |
|---|---|
| Anthropic, OpenAI, xAI, GitHub Copilot, Google, OpenRouter, DeepSeek, or a self-hosted server | Model calls from each bot's Hermes, on a subscription token or sign-in, or an API key. Dispatch itself asks the Anthropic API and the self-hosted server which models they list, and asks GitHub for the Copilot sign-in's code and token |
| SearXNG | `web_search`, when its address is set in Settings > Providers |
| GitHub | On a machine the installer set up, the repository's release tags (or the newest commit of the branch it follows) every six hours (`updates.ts`), and the release when the user clicks Update: its tag, its built tarball and checksums, and its speech image from GitHub's container registry (GHCR). At a terminal, the installer also downloads gum, a pinned release checked against its checksum, for its full-screen questions |
| Open-Meteo | `show_weather`'s forecast cards, called by Dispatch directly (`weather.ts`) |

Hermes still fetches the models.dev registry and installs missing Python packages from PyPI when a tool needs one, and Chrome keeps its own Google traffic.

Provisioning pulls Chrome, Node (for the bots and Hermes' tools) and Docker from their makers' apt repositories and Hermes and its Copilot plugin from GitHub at pinned commits. A release comes built; building one (in GitHub Actions, or on the machine for a branch or a deploy) downloads its pinned Node from nodejs.org and runs `npm ci` against the npm registry.

Building the speech image pulls sherpa-onnx's source from GitHub and the models from Hugging Face and GitHub, each at a pinned revision; at runtime the container has no network route out.
