# Security

## Reporting a vulnerability

Report security problems privately with **Report a vulnerability** on the [Security tab](https://github.com/chriscorbell/dispatch/security), not in a public issue. Say what you found, how to reproduce it, and what it lets someone do. The fix ships in a new release, and the advisory is published once that release is out.

Only the newest release gets fixes. **Settings** > **General** > **Updates** installs it.

## Before you install

Dispatch is made for one owner, on a machine of its own. Know this first:

- **The bots run as root.** Each bot's agent can run any command, read any file on the machine, and reach anything on your network that the machine can. Give Dispatch a computer or VM with nothing on it you'd mind a bot seeing or changing.
- **Your Dispatch account is the key to the machine.** Whoever signs in controls the bots, and through them the machine. Use a password you don't use anywhere else. Sign-in stops for an address after 10 wrong passwords in 15 minutes.
- **Approvals are a safety net, not a wall.** With **Smart**, the default, the bot's own model decides what is risky, and a web page or message the bot reads can try to talk it into something. **Ask** asks before every action.
- **Dispatch is on your local network.** It listens on port 8787 on every address, over HTTPS with a certificate of its own. Don't forward that port to the internet. To reach Dispatch from elsewhere, use Tailscale (the installer can set it up). To keep it off the local network, set `HOST=127.0.0.1` in `/etc/dispatch/env` and restart it; Tailscale Serve still reaches it.
- **Nobody else can claim a fresh install.** Making the account needs the one-time setup code in the link the installer prints.
- **Each bot's Chrome runs without Chrome's sandbox**, because it runs as root. A page that exploits a bug in Chrome could take over the machine. Dispatch's updates don't update Chrome, so keep the machine's packages current: `sudo apt update && sudo apt upgrade`.
- **Provider keys and sign-ins are stored on the machine**, under `/root`, where only root can read them.

## How releases are checked

Dispatch installs and updates only from signed releases. A release is a `vX.Y.Z` tag signed with one of the keys listed in the installer (`release_signers` in [scripts/install.sh](scripts/install.sh)). The installer downloads the release with git, which checks every file against its hash, and checks the tag's signature before it runs anything from the release. It never installs a release older than the one running. The one way back is automatic: when a new release doesn't answer within a minute of starting, `release.sh` switches back to the release that ran before it, which was checked when it was installed.

**Update** in the app runs the installer of the version you already have, so a new release has to be signed by a key that version trusts. Someone who took over the GitHub repository couldn't push an update to your machine without one of those keys.

The first install trusts what GitHub serves when you run it. To read the installer before it runs, download it, read it, then run it:

```bash
curl -fsSLO https://raw.githubusercontent.com/chriscorbell/dispatch/main/scripts/install.sh
less install.sh
bash install.sh
```

`DISPATCH_REF=<branch, tag or commit>` installs that instead of the newest release, with no signature to check, and updates then follow that branch. It is for development.

## What Dispatch guards against

These are meant to hold. A way around one is a vulnerability, so please report it:

- Another web page can't act as you: Dispatch refuses changes, sign-ins and the screen and voice connections when they come from another site, and its pages can't be framed by other sites.
- A file a bot makes can't run script in Dispatch's page: previews don't run it, and Dispatch's Content Security Policy blocks inline and outside scripts.
- The parts behind Dispatch are reachable only from the machine: each bot's Hermes gateway, Chrome DevTools and screen, the home-screen server and the speech service. Web pages in a bot's Chrome or your browser can't use them.
- The password is stored as a scrypt hash, and the session cookie is HttpOnly, SameSite=Lax, and Secure over HTTPS.
