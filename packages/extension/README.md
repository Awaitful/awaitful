# Awaitful

Earn while your AI agent thinks.

Awaitful shows a single, tasteful sponsored line during the seconds your AI coding agent spends "thinking", and shares the revenue with you. No pop-ups, no tracking of your work, no clutter. One line, only while you are already waiting. It is a quiet way to turn unavoidable wait time into passive income.

## How it works

When your coding agent (such as Claude Code) is working, there is a short wait. Awaitful fills exactly that moment with one sponsored line, then gets out of the way the instant the agent is done. Advertisers bid for that attention in a live auction, and a share of what they pay goes to you. You are billed nothing. You earn.

## What leaves your machine

This is the part that matters, so it comes first. Awaitful is built so that your code, prompts, files, and agent output never leave your machine. The client only detects:

- that an agent is currently thinking, and
- for how long.

That is the whole of it. What crosses the network is a device token plus coarse, opt-in signals. Awaitful never reads, uploads, or inspects your source, your prompts, or the agent's responses. The exact list of what is sent is published in [PRIVACY.md](https://github.com/Awaitful/awaitful/blob/HEAD/PRIVACY.md), and this extension is open source, so you can verify every line yourself.

## Surfaces

Awaitful can present its one line wherever fits your setup:

- The VS Code status bar
- The agent's thinking line
- A banner above the composer
- The terminal status line

The same account and earnings follow you across all of them, and the extension fails safe: if it cannot place a line cleanly, it simply shows nothing.

## Getting started

1. Install the extension.
2. Open the Awaitful panel and choose "Link this machine".
3. Approve the link in your browser (email, Google, or GitHub).
4. That is all. Awaitful runs quietly and earns while you work.

## Your earnings

Your dashboard shows impressions, clicks, click-through rate, a per-surface breakdown, your earning streak, and progress toward your next payout. An impression only counts when the sponsored line was genuinely visible while the agent was actually thinking, never before.

## Open source and auditable

The client that runs on your machine is public and read-only at [github.com/Awaitful/awaitful](https://github.com/Awaitful/awaitful). Read it, build it, and confirm it does exactly what this page says. Trust should be verifiable, not asked for.

## Configuration

- `awaitful.apiBaseUrl` - Override the Awaitful server URL. Leave blank to use the default. Useful for local development.

## Commands

Open the Command Palette and search "Awaitful":

- Open Panel
- Sign In / Sign Out
- Resume Earning / Pause Earning
- Open Dashboard
- About

## License

Licensed under the MIT License.
