# Security

## Reporting a vulnerability

Report security problems privately with **Report a vulnerability** on the [Security tab](https://github.com/chriscorbell/dispatch/security), not in a public issue. Say what you found, how to reproduce it, and what it lets someone do. The fix ships in a new release, and the advisory is published once that release is out.

Only the newest release gets fixes. **Settings** > **General** > **Updates** installs it.

## Before you install

Dispatch is made for one owner, on a machine of its own. Know this first:

- **The bots share one ordinary account, and it can sudo.** Every bot runs as the account you ran the installer from, not as root: its agent, screen, Chrome and apps. So a bot has no root shell, and a file one bot makes is every bot's to use.
  - The installer lets that account run anything as root without a password (`/etc/sudoers.d/dispatch`), so a bot can still install what it needs, as a person at the machine would.
  - That keeps a careless command from changing the system without going through sudo, and lets Chrome keep its sandbox. It isn't a wall: whatever runs as that account can use sudo too, and so reach root. That might be a bot talked into it by a page it read, or code that got out of Chrome's sandbox.
  - Each bot can read any file the account can, and reach anything on your network that the machine can.

  Give Dispatch a computer or VM with nothing on it you'd mind a bot seeing or changing, and know that the account you install from gets passwordless sudo.
- **Your Dispatch account is the key to the machine.** Whoever signs in controls the bots, and through them the machine. Use a password you don't use anywhere else. Sign-in stops for an address after 10 wrong passwords in 15 minutes.
- **Approvals are a safety net, not a wall.** With **Smart**, the default, the bot's own model decides what is risky, and a web page or message the bot reads can try to talk it into something. **Ask** asks before every action.
- **Dispatch is on your local network.** It listens on port 8787 on every address, over HTTPS with a certificate of its own. Don't forward that port to the internet. To reach Dispatch from elsewhere, use Tailscale (the installer can set it up). To keep it off the local network, set `HOST=127.0.0.1` in `/etc/dispatch/env` and restart it; Tailscale Serve still reaches it.
- **Nobody else can claim a fresh install.** Making the account needs the one-time setup code in the link the installer prints.
- **Each bot's Chrome keeps Chrome's sandbox**, as on a desktop: its pages render in sandboxed processes. The machine installs Chrome's updates every day with its own security updates (unattended-upgrades), and Dispatch restarts each bot's Chrome on the new version once that bot is idle. Other packages from outside the distribution (Node.js, Docker) need `sudo apt update && sudo apt upgrade`.
- **Provider keys and sign-ins are stored on the machine.** Dispatch's own data (`/var/lib/dispatch`: the database with the keys you set, the secret that signs the bots' tokens, and the setup code) only root can read. Each bot's agent needs its keys and sign-ins, so they are also in its Hermes home, in the bots' account's home (`~/dispatch/engines`), where every bot and that account can read them.

## How releases are checked

Dispatch installs and updates only from signed releases, with the keys listed in the installer (`release_signers` in [scripts/install/install-release.sh](scripts/install/install-release.sh), which is part of `scripts/install.sh`):

- There are two keys: the one releases are signed with, and a spare kept apart from it, so losing one doesn't leave every machine unable to update.
- A release is a `vX.Y.Z` tag signed with one of those keys. The installer fetches the tag with git and checks its signature, which names the release's commit.
- GitHub Actions builds the release from that commit once, for everyone ([release.yml](.github/workflows/release.yml)): a tarball with its own Node, and the speech service's image. `SHA256SUMS` lists the tarball and a manifest naming the version, the commit and the speech image by its digest.
- Before signing, `scripts/publish.sh` builds the same commit on the publisher's machine and stops unless the result is the tarball, file for file, so a tarball GitHub Actions changed doesn't get signed. The speech image isn't rebuilt that way (it takes over an hour): its digest is signed as GitHub Actions reports it. It runs in a container whose only network is the one to Dispatch, with no way out, but it hears every call and speaks the bots' replies.
- One of the keys signs `SHA256SUMS`. The installer downloads the tarball and manifest and installs them only when that signature checks out, both files match it, and the manifest names the tag and the commit its signature names. The speech image is pulled by that digest.

So GitHub Actions is trusted to build, and the publisher's own build checks the tarball (not the speech image); nothing it builds runs on a machine until a release key has signed its checksums. It never installs a release older than the one running. The one way back is automatic: when a new release doesn't answer within a minute of starting, `release.sh` switches back to the release that ran before it, which was checked when it was installed, and to the database as it was before the update.

**Update** in the app runs the installer of the version you already have, so a new release has to be signed by a key that version trusts. Someone who took over the GitHub repository couldn't push an update to your machine without one of those keys: not by moving a tag, and not by changing a release's files.

The first install trusts what GitHub serves when you run it. To read the installer before it runs, download it, read it, then run it:

```bash
curl -fsSLO https://github.com/chriscorbell/dispatch/releases/latest/download/install.sh
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
