# Changelog

Every meaningful change to Awaitful is dated and published, in full, at
**https://awaitful.com/changelog** (and in your dashboard). That page is the canonical log, dated to the
day each change shipped; this file mirrors the highlights of the current release.

## 0.7.4

- Every ad format keeps its own look. The spinner, the advertiser logo, and the chat banner glow are
  set on that format's own page, so a quiet thinking line can run alongside a livelier chat banner.
  Your existing choices carry over.
- Ask for the terminal status line from your dashboard. Your editor still prompts you on the machine
  itself, because it changes a file there, and the dashboard shows when your device has actually
  applied it rather than only that you asked.
- Awaitful now says when it cannot find Claude Code, instead of an empty status bar that quietly
  earns nothing. Each format explains what is missing and what to do, and nothing is written into a
  config folder for a product that is not installed.
- A sponsored line counts only once it is really on screen. If a spot stops drawing, earning moves
  back to your status bar and the panel says why. The same line open in two editors counts once.
- When another extension has changed Claude Code's files, the panel names it and walks you through
  putting the original back, including when that extension is installed in a different editor on the
  same machine. Awaitful never edits another extension's code and never removes or disables one by
  itself: the buttons are there, but the click is yours.
- Your code, your prompts, your files, and your agent's output are never read, on any format. The
  client is open source and a CI test fails the build if it ever contacts an undeclared host.

For the complete, dated history of every change, see https://awaitful.com/changelog.
