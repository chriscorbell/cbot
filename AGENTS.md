# Working on Dispatch

Dispatch is a Node server (`server/`) and a React app (`web/`) that run a small team of Hermes agents, each with its own screen, Chrome and gateway on one machine. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how it runs; this file says how the code is organised and how to change it without breaking it.

## Commands

| Command | What it does |
|---|---|
| `npm run check` | Typecheck both workspaces, lint, and run every unit test. Run it before every commit. GitHub Actions runs it, with shellcheck, on every pull request (`.github/workflows/check.yml`) and `main` requires it to pass; `scripts/deploy.sh` and `scripts/publish.sh` refuse a commit that fails it |
| `npm test` | Unit tests only: Vitest in both workspaces, the box scripts' Python tests (`npm run test:box`), the speech service's (`npm run test:speech`) and the installer's release check and `release.sh`'s rollback (`npm run test:install`, which needs git and ssh-keygen), all stdlib only. Seconds, no services needed |
| `npm run lint` | ESLint: floating promises and non-exhaustive switches in both workspaces, and React's hooks rules in the web app. One TypeScript version (root `package.json`) serves both workspaces and the lint |
| `DISPATCH_PORT=8788 docker compose -p dispatch-dev up -d --build` | The dev app, in Docker. Never run the server on a developer's machine outside the container: it starts real X displays, Chrome and Hermes gateways |
| `scripts/build-release.sh <out>` | The one build of a release: a folder (and with `--tarball`, a tarball) with its own Node, the server, the web app and the server's production dependencies. GitHub Actions, `release.sh` (for source) and the dev image all use it. Linux on x86-64 |
| `node tests/e2e.mjs`, `tests/voice-*.mjs` | End-to-end scripts against a running app (real gateways, screens and speech). See their headers |

## Where things are

| Path | Owns |
|---|---|
| `server/src/index.ts` | Process startup, in order (the comment lists it). Nothing else starts work at import time |
| `server/src/app.ts` | The HTTP app: every `/api` route behind sign-in except `/api/health` and the account routes that come before a session (`routes-auth.ts`). The web app's files are open; the agents' `/mcp/*` has bearer tokens of its own. Tests build it with `createApp()` |
| `server/src/routes*.ts`, `mcp.ts`, `voice.ts` | HTTP routes, the agents' MCP endpoint, voice call routes. Thin: validate, call a module, answer |
| `server/src/db.ts` | The whole schema, migrations, and a record type per table |
| `server/src/store.ts` | Bots and rows: reading, appending, rewriting, `Conversation` handles, unread counts |
| `server/src/agent/turns.ts` | Each bot's turn runner and the turn itself |
| `server/src/agent/run-events.ts` | What a Hermes run sends and answers, checked with zod as it arrives |
| `server/src/agent/transcript.ts` | What the events of a turn's Hermes run become in the chat |
| `server/src/agent/live.ts` | What each bot is doing right now |
| `server/src/agent/tools.ts` | The app's MCP tools (zod parameters, implementation, activity label) |
| `server/src/agent/catchup.ts` | What a voice call and the text chat are told of each other before each run |
| `server/src/agent/rooms.ts`, `routines.ts`, `proactive.ts` | Group chats, routines, check-ins |
| `server/src/agent/approvals.ts` | Hermes' approval prompts as chat cards, and the answers sent back to the run |
| `server/src/bots.ts` | Creating and deleting a bot (deletion takes everything down in a fixed order), and the first-run setup that makes the first one |
| `server/src/reset.ts` | Resetting Dispatch to a fresh install: every bot deleted, the data erased, then the process exits for its supervisor to restart it |
| `server/src/updates.ts` | Updating Dispatch from GitHub: checking for a newer release (or commit of the branch the installer was told to follow), and running this release's installer again in a unit of its own |
| `scripts/install/`, `scripts/bundle.sh`, `scripts/publish.sh`, `.github/workflows/release.yml` | Installing and updating from signed releases (`release_signers`, `fetch_signed` for the tag and `fetch_assets` for the build, in `install-release.sh`), building a release from its tag in GitHub Actions, and publishing it: `publish.sh` checks the build against its own and signs its checksums. `.node-version` and `scripts/node.sha256` pin the Node a release brings; change them together. Changing `release_signers` changes which keys every machine trusts once it updates. `curl \| bash` fetches one file, so `scripts/bundle.sh` joins the parts into `install.sh` and `uninstall.sh`. Those aren't committed: every build bundles them (`build-release.sh`), each release has them attached, and the install and uninstall commands download them from the newest release. Edit the parts. `common.sh` is in both |
| `server/src/library.ts` | Attached files in a Library's `uploads/`: names, copies, and what the bot is told |
| `server/src/engine.ts` | Each bot's Hermes home and gateway |
| `server/src/units.ts`, `deploy/dispatch-*@.service`, `scripts/install-units.sh` | The systemd units each bot's screen, gateway, Chrome and apps run as, and each bot's slice with its memory limit |
| `server/src/signin.ts` | Subscription sign-ins with a link and a code (ChatGPT, Grok, Copilot) |
| `server/src/https.ts` | HTTPS=1: Dispatch's own certificate and the port that serves HTTPS and plain HTTP together |
| `server/src/computer.ts`, `displays.ts`, `desk.ts`, `vnc.ts`, `server/box/` | Screens: leases, X displays, dressing, the viewer relay, the Python desk scripts |
| `server/src/voice-relay.ts`, `speech.ts`, `speech/` | Voice calls: the realtime relay, the speech service client, the speech service |
| `server/src/account.ts` | The ordinary account every bot runs as (`DISPATCH_USER`), and handing it what the root server writes for the bots |
| `server/src/machine.ts` | Paths, ports and display numbers on the computer |
| `server/src/types.ts`, `contract.ts`, `voice-protocol.ts` | Everything shared with the web app (imported there as `@shared/types`, `@shared/contract`, `@shared/voice-protocol`) |
| `web/src/store.ts`, `configStore.ts` | App state (zustand): bots, transcripts, live state; and UI state (settings, theme) |
| `web/src/lib/events.ts` | The SSE stream: one exhaustive switch from server event to store action |
| `web/src/lib/http.ts`, `api.ts`, `configApi.ts`, `voice/api.ts` | The only way the web app calls the server |
| `web/src/voice/` | Calls in the browser: the socket, microphone and player, dictation |
| `server/test/`, `web/test/` | Unit tests |

## State machines and who owns them

Each lifecycle has one owner module. Its states are written down there; other code calls its functions and never writes its fields.

| Lifecycle | Owner | States |
|---|---|---|
| A bot's turns | `agent/turns.ts` | idle, running (with a queue). Stop ends the running turn; New chat and delete also drop the queue. A turn belongs to the generation it was queued in |
| A turn's text and tool rows | `agent/transcript.ts` | text: nothing, holding, streaming, closed as a message or a note. Tool rows: running, done or error |
| What a bot is doing | `agent/live.ts` | idle, running. `LiveState` in `types.ts` allows only those two shapes |
| A conversation | `store.ts` | generation N, then N+1 on New chat. Rows are addressed by bot, generation and seq |
| A bot's gateway | `engine.ts` | none, starting, ready, error (diagram in the file header). The process is `dispatch-gateway@<bot>.service`, which systemd restarts when it crashes and keeps across server restarts; `units.ts` names the units |
| A provider sign-in | `signin.ts` | starting, waiting (link and code shown), then done, failed or cancelled once. One per bot, one for Copilot; in memory |
| A bot's screen | `computer.ts` | lease, display (`displays.ts`, `dispatch-display@<n>.target`), dressed (`desk.ts`). A dressing job (its own scope) holds the display's lock (`held_lock` in `dispatchlib.py`); undressing waits for it, then stops it. What runs on the screen runs as units in the bot's slice, which systemd knows, so nothing searches the process table for it |
| A voice call (server) | `voice.ts` | created, relayed once, ended |
| A voice reply | `voice-relay.ts` | `planAnswer` decides barge-in; a Reply's flags are listed in the header |
| A voice call (browser) | `web/src/voice/call.ts` | idle, connecting, live, error |
| A question card | `routes.ts` (answer route) | pending, then answered once |
| An update of Dispatch | `updates.ts` | off (not an installer's machine), idle, updating, failed. One per machine, in memory; a finished update restarts the process on the new release, which starts idle. A new release that doesn't answer is rolled back by `scripts/release.sh`, and the old one starts failed from `/etc/dispatch/last-update` |
| A Hermes approval prompt | `agent/approvals.ts` | pending, then allowed, always, denied or expired once. Pending ones live in memory beside their run |
| First-run setup | `bots.ts` (`setupPending`, `finishSetup`) | no account, then pending (`users.setup_at` null) while `web/src/components/SetupWizard.tsx` makes the first bot, then done once. The first bot is primary and greets when setup finishes |

## Rules that keep it working

- **One schema.** Every table and column is in `db.ts`. To change the schema, append a migration to `MIGRATIONS` and update the record type beside it. Never edit a shipped migration, never alter tables anywhere else, and never drop a table or column with data in it without asking Chris.
- **Typed records.** Query with `db.prepare<Params, Record>(...)`. Use `requireBot(id)` where a bot must exist and `getBotRow(id)` where it may be gone. No `as any` on query results.
- **Rows carry their generation.** Keep a `Row` or `RowRef`, not a bare seq, across an await. Work that outlives a request (a turn, anything on a timer) writes through a `Conversation`. App tools write through `ctx.convo`, the conversation of the turn that called them. A request the user makes (a message, an answer, hanging up a call) writes into the bot's current chat.
- **Requests name rows by generation.** The web app sends a row's `generation` with an answer or a reaction; the server refuses an answer to a cleared chat and patches the row of that generation.
- **Read, check, write with no await between.** A route that checks state before changing it (a question still pending) reads it after its last `await`, so two requests at once can't both pass the check.
- **Live state through `live.ts`.** Only `agent/turns.ts` and `agent/transcript.ts` call its transitions.
- **Validate at the boundary.** Route bodies go through `body(c, schema)` from `lib/validate.ts`. Tool arguments are the tool's zod `params`. Data from outside is parsed with zod where it enters, like route bodies: Hermes' run events and answers (`agent/run-events.ts`, `engine.ts`), the MCP envelope (`mcp.ts`), the speech service's and the browser's call events (`voice-relay.ts`), and other services (`weather.ts`). What doesn't fit is logged and dropped, or fails the request with a clear error; it is never cast. Inside, trust the types; lint refuses `any`.
- **Contracts are shared, not restated.** A route's response type lives in `contract.ts` and the handler returns `{ ... } satisfies ThatType`; the web call names the same type. Server events are `ServerEvent` in `types.ts`; voice messages are in `voice-protocol.ts`. `types.ts`, `contract.ts` and `voice-protocol.ts` import nothing from the server, because the web app bundles them.
- **Exhaustive switches.** A switch over a union ends with `default: { const x: never = ev; ... }` where it must handle every case (`lib/events.ts`, `voice/call.ts`). Lint enforces it in both workspaces.
- **No floating promises.** Await it, `.catch` it, or write `void` when it is deliberate and cannot reject. An unhandled rejection stops the server; in the browser it fails without a word. A caught error is `unknown`: read it with `errorText` and `errorField` (`server/src/lib/errors.ts`).
- **Exact versions.** Every dependency is pinned to one version in `package.json`, and Dependabot proposes the updates. TypeScript, Vite and Vitest are declared once, at the root.
- **Constants in one place.** Paths, ports and display numbers the box scripts need too are in `server/box/machine.json`, which `machine.ts` and `server/box/dispatchlib.py` both read; change them there. Other server-only paths are in `machine.ts`, and the speech service's fixed address on a host is in `deploy/speech.env`.
- **The bots' files are their account's.** Every bot runs as one ordinary account (`account.ts`); the server is root. Whatever the server writes under the bots' folders (`BOTS_ROOT`: Hermes homes, Libraries, Chrome profiles) goes through `own`/`mkdirOwned` (or `box.writeFile`, which does it), and a command it runs in a bot's home goes through `asAccount`; the box scripts use `own`, `write_owned` and `as_account`. Otherwise a bot can't change its own file. The server's own data (`DATA_DIR`) stays root's.
- **The MCP tool list is a contract with every bot's model.** `test/fixtures/mcp-tools.json` records what Hermes is offered. Changing a tool's name, description or parameters changes that file on purpose. Renaming or adding a tool restarts every gateway on the next deploy (the settings hash covers tool names).
- **Long-lived processes are systemd units.** A display, a gateway, a Chrome, the dock, the home screen server and whatever the bots open on their screens run as units of their own (`units.ts`, `dispatchlib.py`), outside `dispatch.service`, so restarting the server leaves them running. Start, find and stop them through systemd; never spawn something long-lived detached from the server.
- **Nothing starts at import.** Modules may prepare statements and define things; timers, processes and network calls start from `index.ts` (the `init*` functions) or from a request.
- **Comments explain why.** Keep the existing voice: plain sentences about what the code is for and what would break.

## How to change things

**Add an HTTP route.** Put it in the router for its area (`routes.ts`, `routes-config.ts`, `routes-rooms.ts`, `routes-proactive.ts`, `voice.ts`). Check ownership with `ownBot(userId, id)` and return 404 for anything else. Read the body with `body(c, schema)`. Add the response type to `contract.ts` and return `satisfies` it. Add the call to `web/src/lib/api.ts` or `configApi.ts` with that type. Add a test to `server/test/routes.test.ts`.

**Add a server event.** Add it to `ServerEvent` in `types.ts`, emit it with `hub.emit`, and the web build fails until `applyServerEvent` in `web/src/lib/events.ts` handles it.

**Add an app tool for the agents.** Add a `tool({...})` to `TOOLS` in `agent/tools.ts` with zod `params` (`.describe()` gives a parameter its description), an activity and a label. Mention it in `agent/prompt.ts` if the agent needs to know when to use it, and in the tool list in `docs/ARCHITECTURE.md`. Regenerate `server/test/fixtures/mcp-tools.json` with `UPDATE_FIXTURES=1 npm test -w server` and review the diff. A tool that ends the turn returns `endTurn: true`.

**Change what a turn shows.** Change `agent/transcript.ts`, and first add a test to `test/turn.test.ts` that scripts the Hermes stream (`test/hermes.ts`) and asserts the rows. Every existing test there pins visible chat behaviour; one that fails is a UX change, so decide whether it is wanted.

**Change the schema.** Append to `MIGRATIONS` in `db.ts`, update the record type, and extend `test/db.test.ts` if a legacy database needs care.

**Add a row or card kind.** Add it to `RowBody` or `CardBody` in `types.ts`, write it with `appendRow` or a `Conversation`, render it in `web/src/components/Transcript.tsx` or `cards/Cards.tsx`, and give the preview text in `toBot` (`store.ts`).

**Change the voice protocol.** Change `voice-protocol.ts`; the relay and the browser both fail to compile until they agree. The speech service's events are documented in `speech/README.md`.

**Add web state.** Data from the server goes in `web/src/store.ts` with a named action; view-only state stays in the component or `configStore.ts`. An optimistic change keeps the previous value and rolls back only if nothing newer replaced it (see `patchRow`). A request from one part of the UI to another with no shared parent ("put this in the composer") goes through `web/src/lib/uiEvents.ts`, typed. An async answer that may arrive after the user switched bots, or after the panel closed, goes through `guarded()` (`web/src/lib/guarded.ts`) or checks it is still about the bot shown (see `Composer.tsx`, `EngineSettings.tsx`). A reply in the composer names its row by generation too (`web/src/lib/reply.ts`).

**Change behaviour the user sees.** Update `README.md` (what Dispatch is and how to install it), `docs/RUNNING.md` (how to run it) and `docs/ARCHITECTURE.md` in the same commit, and say in the commit message what changed for the user. Don't invent new UI patterns without asking.

## Tests

- Server tests are in `server/test/`, web tests in `web/test/`, named `*.test.ts`. The box scripts' tests are `server/box/test_*.py` (unittest, no display or packages needed).
- `server/test/env.ts` gives every test file a fresh database in a temporary folder and fails any test that starts a child process other than Node. Code that would start a display, Chrome, a gateway or a turn is mocked with `vi.mock`, as `routes.test.ts` and `turn.test.ts` do.
- `server/test/helpers.ts` has `seedOwner()`, `seedBot()` and request helpers; `server/test/hermes.ts` fakes a gateway's event stream with `fakeHermes(...)` and `gate()`.
- The scripts in `tests/` need the whole app running and are not part of `npm test`.

## Git

Work in a worktree on a branch; other agents may be using the main checkout. Stage only the files you changed. Changes reach `main` through a pull request whose `check` workflow passed. Make each commit one change: its message says what changed and why, in plain sentences, with no attribution lines. The image workflows (`app-image.yml`, `speech.yml`) run only when what goes into an image changes. Node's version is in `.node-version`.
