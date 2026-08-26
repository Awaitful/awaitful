# Changelog

Every meaningful change to Awaitful is dated and published, in full, at
**https://awaitful.com/changelog** (and in your dashboard). That page is the canonical log, dated to the
day each change shipped; this file mirrors the highlights of recent releases.

## 0.7.6

- Two-way sync. Picking an ad format on any synced machine now sets it for your account, so your other
  machines follow the choice you made where you made it, rather than only following the dashboard. The
  terminal status line works the same way, so switching it on where you are sitting is no longer undone
  a few minutes later. Your dashboard updates live as a machine reports in, without a refresh.
- A choice you make sticks even if the network does not. If the change cannot reach your account right
  away it is kept and sent again, instead of being quietly replaced by the older setting. And a format
  is only shared with your other machines once it has actually worked on the one you chose it from.
- No more reload nagging on a synced machine. When a format arrives from sync it is applied quietly, so
  a machine you are not sitting at stops interrupting you about a change you made somewhere else.
- The sponsored line works again on the newest Claude Code builds. A recent Claude Code update moved
  the file Awaitful attaches to, which paused the thinking line and chat banner until the format was
  turned on again.
- "Restore original files" now stays restored. On a synced machine your account could ask for the format
  back within minutes of you removing it. Restoring is how you put Claude Code back exactly as it was, so
  it now settles the request instead of being quietly undone by it.
- The panel stops taking your tab. It could pull itself to the front while you were reading something
  else, most noticeably while your agent was thinking. It only comes forward when you ask for it now.
- Starting out with another ad extension installed no longer sends you to the terminal. Setup offers the
  status bar, which works everywhere, instead of a format that needs a file it cannot get to.

## 0.7.5

- A guided setup checklist. When you sign in, the panel walks you through three steps: sign in, turn
  on your best-earning ad format, and sync your settings across your devices. It clears itself once you
  finish or dismiss it, and every choice stays changeable afterwards.
- "Sync across devices", the clearer name for what used to be called "Control from web". Pick the ad
  format you want on one device or from your dashboard, and Awaitful applies it to your other devices.
  Turning it on still asks you on each machine before it changes a file there, because only the machine
  can allow that.
- One machine stays one machine. Signing out and back in used to add a new entry to your connected
  machines every time; Awaitful now recognizes the same machine across sign-ins and keeps the name you
  gave it, so the list stays clean. It uses an id your machine already made up for itself, so nothing
  new leaves your computer.
- A short "what's new" note after an update, shown once in the panel with a link to the full changelog,
  then out of your way.
- A clearer message when another extension has changed Claude Code's files. If a competitor has written
  over Awaitful's changes and you use Restore, the panel now tells you another extension changed the
  files, instead of reporting there is nothing to restore.

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
