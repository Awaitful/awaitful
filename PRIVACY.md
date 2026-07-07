# Privacy - what Awaitful can and cannot see

> This document is the plain-English contract for what leaves your machine. It is meant to be
> read alongside the source: every claim here is enforced by code you can inspect. If you are
> an AI or a human auditing this extension, start here, then verify against the files cited.

Awaitful shows a single sponsored line while your AI coding agent is thinking, and pays you a
share of the ad revenue. To do that it needs to know **that** an agent is thinking and **for how
long** - nothing about **what** you or the agent are doing.

## The one rule everything is built around

**Awaitful never reads your code, prompts, files, chat, or the agent's output.** The client
detects only *that* an agent is in a "thinking" state and *how long* the sponsored line was
actually visible. It does this by watching the agent's own spinner/thinking indicator - never
by reading buffers, transcripts, or the filesystem.

This is not a promise you have to take on faith. It is enforced two ways:

1. **The wire payloads are a fixed, tested whitelist** (below). A field that could carry content
   cannot be added without failing CI - see
   [`packages/shared/src/__tests__/egress.test.ts`](packages/shared/src/__tests__/egress.test.ts).
2. **There is exactly one egress chokepoint** in the client:
   [`packages/extension/src/lib/http.ts`](packages/extension/src/lib/http.ts) (`getJson` /
   `postJson`). Every server call goes through it. Grep for it and you can see all of them.

## Everything the client ever sends to the server

The client makes only these calls. Each row lists **every** field on the wire. There is no
free-text field, no path, no buffer, no file content anywhere in this table.

### 1. Get an ad to show - `GET /v1/ad`
| field | what it is |
| --- | --- |
| `placement` | which surface is rendering (`status-bar`, `thinking-line`, `chat-banner`, …) |
| `hints` | **coarse, opt-in only** (e.g. hour-of-day). Never content. Off unless you enable it. |

Plus your device token in the `Authorization` header (see §Device token).

When fetching a patch recipe, the client also sends the Claude Code `agent`/`build` identifier and
an optional `channel` (`stable` or `canary`) - a coarse rollout selector, never content.

### 2. Report ad events - `POST /v1/events`
A batch of `{ deviceId, events[] }`. Each event carries **only**:

| field | what it is |
| --- | --- |
| `eventId` | a random UUID the client generates, so re-sends can't double-count |
| `type` | one of a fixed set: rendered / viewable / view_tick / view_threshold_met / click / error_impression |
| `adId` | which sponsored line it was |
| `slateId` | which pre-decided ad batch it came from |
| `placement` | which surface showed it |
| `occurredAtClientMs` | a timestamp (advisory; the server stamps its own receipt time) |
| `visibleMs` | how many milliseconds the line was actually visible (capped server-side) |

That is the complete list. "How long a sponsored line was on screen" is the *most* specific
thing Awaitful learns about your session.

### 3. Check the killswitch - `GET /v1/killswitch`
No body. Returns whether ads are paused fleet-wide.

### 4. Patch-health report - `POST /v1/patch/report`  *(patch mode only)*
When you opt into a surface that modifies Claude Code, the client verifies Claude Code's own
files and reports the result so the fleet can agree on which build is safe to patch. It carries
**only**:

| field | what it is |
| --- | --- |
| `agent` | e.g. `claude-code` |
| `buildId`, `version` | which Claude Code build |
| `webSha256`, `extSha256` | SHA-256 hashes of **Claude Code's own bundled files** (not yours) |
| `clean` | whether those files were pristine (unpatched) when observed |
| `outcome` | applied / apply-failed / conflict / restored / self-activated / unknown-build |

These are hashes of the editor's shipped bytes, used to recognize a known-good build. They
cannot be reversed into, and never contain, any of your content. A wrong hash can only make the
client **refuse to patch** (fail safe) - it can never corrupt your editor. See
[`docs/CONTRACT.md`](docs/CONTRACT.md) §Recipe delivery.

### 5. Account reads - `GET /v1/me`, `GET /v1/earnings/summary`  *(read-only)*
So the panel can show whose account is earning and how much. A device token can **read** these
two routes and nothing else - it can never move money, change campaigns, or enumerate devices.

### 6. Sign-in / device link - `POST /v1/auth/link/*`
The one-time flow that ties this device to your account. Exchanges a link code for a device
token. No content.

## Device token
After you sign in, the device holds one opaque, revocable token, sent as
`Authorization: Bearer …`. It identifies *the device*, not *you inside a session*. You can
revoke it from the dashboard at any time; the server honors revocation immediately.

## What runs inside Claude Code stays local
The surfaces that render inside Claude Code (the thinking-line, chat-banner, and terminal status
line) talk **only** to a Awaitful helper on `127.0.0.1` on your machine - never to the server. Those
loopback messages are just "draw the current line" and "the line was seen/clicked". The server
never receives anything from inside the editor except the whitelisted ad events above. See
[`docs/CONTRACT.md`](docs/CONTRACT.md) §Host-internal surface channel.

The terminal status line adds a `statusLine` to `~/.claude/settings.json`. Its script
([`packages/extension/src/hooks/statusLineScript.ts`](packages/extension/src/hooks/statusLineScript.ts))
talks only to that loopback helper and **sends no content**: Claude Code passes it session JSON on
stdin (which includes a `transcript_path` we deliberately never read), and the script uses that
stdin *only* to forward to your own previous status line - never to the network. Your existing
status line is preserved and restored when you turn the surface off.

## What we deliberately do NOT do
- We do **not** read your source files, open buffers, terminal, or clipboard.
- We do **not** read your prompts or the agent's responses.
- We do **not** send file names, paths, project names, or repository info.
- We do **not** fingerprint you across sites; there is no third-party tracker in the client.
- We do **not** ship ad-rendering or glow code from the server - the code that runs is in this
  source tree, and the client re-verifies every byte before it patches anything.

## How to check for yourself
- **All egress in one file:** [`packages/extension/src/lib/http.ts`](packages/extension/src/lib/http.ts).
- **The exact payload shapes, enforced:** [`packages/shared/src/schemas.ts`](packages/shared/src/schemas.ts)
  and the test at [`packages/shared/src/__tests__/egress.test.ts`](packages/shared/src/__tests__/egress.test.ts).
- **The "never read content" rule, stated for agents:** golden rule 1 in
  [`CLAUDE.md`](CLAUDE.md).

If you find anything in the source that contradicts this document, it is a bug in this document
or the code - please open an issue. The code is the source of truth, and it is public.
