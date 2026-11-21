<p align="center">
  <img src="assets/readme-banner.svg" alt="Dispatch: a team of AI agents, each with its own desktop" width="100%">
</p>

**Dispatch** runs a team of always-on AI agents, **self-hosted on a single machine.**

Each bot is a [Hermes Agent](https://github.com/NousResearch/hermes-agent) with its own name, instructions, memory, routines and Linux desktop.

https://github.com/user-attachments/assets/54f0e200-13e1-416a-9181-69a80f4627e5

## Features

- A desktop for each bot (with Chrome, a terminal and file manager) that you can watch or take control of
- Scheduled routines and check-ins
- Group chats, and bots that message each other
- Memory you can review and prune
- Search across bots, messages, library files and folders
- A library of the files that your bots create and the files you attach
- Voice calls
- Dictation
- A phone layout you can add to your home screen as an app

## Supported providers

- Claude subscription
- ChatGPT subscription
- Grok subscription
- GitHub Copilot subscription
- Anthropic API
- OpenAI API
- Google Gemini API
- xAI API
- DeepSeek API
- OpenRouter API
- Self-hosted OpenAI-compatible server (vLLM, llama.cpp, Ollama)

## Approvals

The options in **Settings** > **Permissions** decide whether the bots ask for approval before performing an action:

- **Smart** (default) only asks if the bot's model judges the action as risky
- **Off** never asks
- **Ask** always asks

## Requirements

### Hardware

You need a **dedicated** machine:

| | Minimum | Recommended |
|---|---|---|
| CPU | x86-64 (amd64), 2 cores | 4+ cores (voice uses up to 4) |
| Memory | 4 GB (1 bot) | 2 GB + 1 GB per bot (8 GB for the default 4 bots) |
| Disk | 25 GB free | 40 GB+, since bots install software and keep files |

### Operating system

Ubuntu Server 26.04 LTS is the main target. These are tested too, and install and run the same:

| Distribution | Releases |
|---|---|
| Ubuntu | 26.04 LTS, 24.04 LTS, 22.04 LTS |
| Debian | 13 (trixie), 12 (bookworm) |

Other Ubuntu and Debian derivatives may work; the installer warns that they're untested. Other distributions (Fedora, Arch and so on) and ARM machines aren't supported.

## Quick setup

### Install

On the target machine, run:

```bash
curl -fsSL https://raw.githubusercontent.com/chriscorbell/dispatch/main/scripts/install.sh | bash
```

The installer takes over the terminal: you pick the bots' time zone from a list you can search, how many bots the machine can run, and whether to add Tailscale, then it shows each step as it installs. A first install takes 15 to 30 minutes.

After installation is complete, open the link the installer prints, `https://<ip-address>:8787/#setup=<code>`, in your browser (accept the certificate warning), create your account, then follow the setup wizard. The link carries a one-time setup code, so nobody else on your network can make the account first.

Dispatch signs its own certificate, since browsers allow the microphone (and so voice calls) only over HTTPS. To stop the warning on a device, trust the certificate from **Settings** > **General** > **Certificate**. For an address with no warning that works from anywhere, choose **Set it up** at the installer's Tailscale question.

When a new version is out, **Update available** shows in the sidebar, and one click installs it. Dispatch installs and updates only from releases signed with its release key.

[docs/RUNNING.md](docs/RUNNING.md) covers updates, settings, HTTPS, models, a forgotten password and starting over.

### Uninstall

On the target machine, run this to remove Dispatch and all its data (Chrome, Node.js, Docker, the desktop packages and Tailscale stay installed):

```bash
curl -fsSL https://raw.githubusercontent.com/chriscorbell/dispatch/main/scripts/uninstall.sh | bash
```

It asks once before removing anything, then shows each step as it goes.

## Security

Dispatch's bots run as root and can do anything on the machine, so give it a machine of its own, keep it off the internet (use Tailscale to reach it from elsewhere), and use a password you don't use anywhere else. [SECURITY.md](SECURITY.md) explains what Dispatch protects and what it trusts, and how to report a vulnerability privately.

## Development

[AGENTS.md](AGENTS.md) explains how the code is organized and the rules for changing it. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how it works, including turns, screens, group chats and voice. [docs/RUNNING.md](docs/RUNNING.md#development) has the development container.

### Stack

- TypeScript, Node, Hono, SQLite and zod
- React 18, Vite and zustand
- Hermes Agent for each bot's model calls, memory and tools
- TigerVNC, Chrome and noVNC for the desktops
- sherpa-onnx with Parakeet, Nemotron and Silero VAD for speech recognition, Phonon 31M for text-to-speech

## License

Dispatch is free software under the [GNU General Public License v3.0 or later](LICENSE).
