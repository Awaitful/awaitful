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
   `postJson`). Every server call goes through it, and a source guard keeps it that way: the test at
   [`packages/extension/src/__tests__/egress.test.ts`](packages/extension/src/__tests__/egress.test.ts)
   scans the client and fails the build if a raw network call appears in any other file. (The surfaces
   drawn inside Claude Code reach a `127.0.0.1` loopback helper on your own machine, never the server —
   see "What runs inside Claude Code stays local" below.)

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
client **refuse to patch** (fail safe) - it can never corrupt your editor. How recipes are
delivered, keyed by build hash, and applied is all in the patch code, starting with
[`packages/extension/src/patch/recipe.ts`](packages/extension/src/patch/recipe.ts).

### 5. Account reads - `GET /v1/me`, `GET /v1/earnings/summary`  *(read-only)*
So the panel can show whose account is earning and how much. A device token can **read** these
two routes and nothing else - it can never move money, change campaigns, or enumerate devices.

### 6. Report an applied surface - `POST /v1/me/surface-applied`
If you set a preferred surface from the web dashboard, this is how a linked device confirms it
actually applied that surface on your machine - one field, `surface` (e.g. `thinking-line`),
nothing else. It carries no content and cannot change anything about your account beyond that one
fact; it exists so the dashboard can tell "applied, waiting for the first ad to confirm it" apart
from "nothing has happened on any device yet".

### 7. Report the terminal status line - `POST /v1/me/terminal-applied`
The same thing as above, for the terminal line, which is additive rather than one of the surfaces.
One field, `enabled` (`true` or `false`), nothing else. Both outcomes are reported: a device that
turns the line off is confirming just as much as one that turns it on. Asking for it from the
dashboard never applies it on its own - turning it on changes `~/.claude/settings.json`, so your
editor asks you there first, and this is only how it tells the dashboard what actually happened.

### 8. Sign-in / device link - `POST /v1/auth/link/*`
The one-time flow that ties this device to your account. Exchanges a link code for a device
token. No content.

## Device token
After you sign in, the device holds one opaque, revocable token, sent as
`Authorization: Bearer …`. It identifies *the device*, not *you inside a session*. You can
revoke it from the dashboard at any time; the server honors revocation immediately.

## What runs inside Claude Code stays local
The surfaces that render inside Claude Code (the thinking-line, chat-banner, and terminal status
line) talk **only** to a Awaitful helper on `127.0.0.1` on your machine - never to the server. Those
loopback messages are the whole vocabulary: "which helper is this" (`/surface/hello`), "draw the
current line" (`/surface/creative`), "the line was drawn / seen / clicked"
(`/surface/rendered`, `/surface/visible`, `/surface/click`), and "I had a line and could not place
it" (`/surface/attest`). The server never receives anything from inside the editor except the
whitelisted ad events above. That host-internal channel is
[`packages/extension/src/hooks/server.ts`](packages/extension/src/hooks/server.ts), whose own header
marks it "host-internal (not the server contract)".

Two of those messages carry identifiers, and it is worth being precise about what they are. Each
editor **window** mints a random `hostId` when it starts, and each copy of the in-editor script mints
a random `shimId` when it loads. Both are random per session, live only in memory, and are never
sent to the server or written to disk. They exist because every window's script scans the same
loopback port range, so without them one window's helper cannot tell its own script apart from
another window's - which is how one advert being open in two editors could be counted as twice the
viewing time, and how a broken surface looked identical to a hidden one. They identify a window and
a script instance for the length of a session. They do not identify you, your machine, or your
project, and they do not persist. `/surface/attest` carries exactly `hostId`, `shimId`, the script
version, the literal string `no-anchor`, and the ad id it was trying to place - no page text, no
URL, no selector, nothing from your editor.

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
- **All egress in one file, and proven so:** every server call goes through
  [`packages/extension/src/lib/http.ts`](packages/extension/src/lib/http.ts), and the test at
  [`packages/extension/src/__tests__/egress.test.ts`](packages/extension/src/__tests__/egress.test.ts)
  scans the source to prove no network call happens anywhere else, then pins that the GET wrapper
  sends no request body while the POST wrapper sends only the body you can see - so even the body-less
  calls (the killswitch and the account reads) cannot carry content.
- **The exact payload shapes, enforced:** [`packages/shared/src/schemas.ts`](packages/shared/src/schemas.ts)
  and the test at [`packages/shared/src/__tests__/egress.test.ts`](packages/shared/src/__tests__/egress.test.ts),
  which pins the field set of every body and query, now including the device-link handshake.
- **The "never read content" rule, in full:** the first section of this document,
  [The one rule everything is built around](#the-one-rule-everything-is-built-around) - and it is
  not just asserted there: the single chokepoint and the whitelist test above are what enforce it.

If you find anything in the source that contradicts this document, it is a bug in this document
or the code - please open an issue. The code is the source of truth, and it is public.
