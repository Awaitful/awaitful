# awaitful

One command to set up [Awaitful](https://awaitful.com): earn from your AI coding agent's wait
time. When your agent (Claude Code and others) is thinking, Awaitful shows a single tasteful,
clickable sponsored line in your editor, and you earn a share of what the advertiser paid.

```
npx awaitful
```

The installer finds your editor, runs `<editor> --install-extension awaitful.awaitful`, and tells
you the one step left: run **"Awaitful: Sign In"** from the Command Palette. That is the entire
job. Your editor downloads the extension from its own marketplace, and keeps it updated the same
way it updates everything else.

## Supported editors

| Editor           | Detected as     | Extension comes from |
| ---------------- | --------------- | -------------------- |
| VS Code          | `code`          | VS Code Marketplace  |
| Cursor           | `cursor`        | Open VSX             |
| Devin            | `devin`         | Open VSX             |
| VSCodium         | `codium`        | Open VSX             |
| VS Code Insiders | `code-insiders` | VS Code Marketplace  |

Editors are found on your PATH first, then in their usual install locations (so a Mac without the
`code` shell command still works).

```
npx awaitful                      # one editor found: installs; several: asks
npx awaitful --editor cursor      # no prompt
npx awaitful --all                # every detected editor
npx awaitful --dry-run            # print the exact commands, run nothing
npx awaitful status               # where is Awaitful installed, and which version
```

## What this package will never do

- **No network requests.** The installer never talks to the network itself; only your editor
  downloads anything, through its own marketplace channel. This is
  [enforced by a test](https://github.com/Awaitful/awaitful/blob/HEAD/packages/cli/test/receipts.test.js)
  that fails the build if a network primitive ever appears in the shipped source.
- **No dependencies.** Zero, enforced by the same test file. What you install is what you can
  read in a few minutes: [the source](https://github.com/Awaitful/awaitful/tree/HEAD/packages/cli).
- **No tracking.** It does not know or report whether you ran it.

The extension itself makes the same kind of promises with the same kind of receipts. What leaves
your machine, field by field: [PRIVACY.md](https://github.com/Awaitful/awaitful/blob/HEAD/PRIVACY.md).
It never reads your code, prompts, files, or your agent's output.

## Manual install

No npm handy, or you would rather not run an installer at all:

- VS Code: [marketplace.visualstudio.com/items?itemName=awaitful.awaitful](https://marketplace.visualstudio.com/items?itemName=awaitful.awaitful)
- Cursor, Devin, VSCodium: [open-vsx.org/extension/awaitful/awaitful](https://open-vsx.org/extension/awaitful/awaitful)

Or from any of those editors directly: search "Awaitful" in the Extensions view.

## Troubleshooting

**"No supported editor was found"** - your editor's CLI is probably not on the PATH. In VS Code
open the Command Palette and run "Shell Command: Install 'code' command in PATH" (Cursor,
Devin and VSCodium have equivalents), or install manually with the links above.

**Several editors, non-interactive shell** - pick one explicitly: `npx awaitful --editor code`,
or take them all: `npx awaitful --all`.

## Development

```
node --test          # the suite, including the no-network and no-dependency receipts
npx tsc -p .         # typecheck (checked JavaScript, no build step)
```

Issues: [github.com/Awaitful/awaitful/issues](https://github.com/Awaitful/awaitful/issues)

MIT (c) Awaitful
