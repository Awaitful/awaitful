# Awaitful client

Public, read-only mirror of the Awaitful client - the code that runs on your machine.

Awaitful shows a single, tasteful sponsored line while your AI coding agent is thinking, and shares the revenue with you. It only detects that an agent is thinking and for how long. It never reads your code, prompts, files, or the agent's output.

The Awaitful server, dashboards, and auction engine are a separate, private codebase. This repository contains only the client, so you can read and build exactly what runs on your machine.

## Repository layout

This is a small pnpm workspace:

- `packages/extension` - the VS Code extension. This is the audit anchor: the same code the Marketplace and Open VSX install.
- `packages/shared` - the API contract the client speaks to the server: types, validation schemas, and constants. It is the precise definition of what the client sends and receives.
- `packages/cli` - the `npx awaitful` installer.

The `extension` and `shared` sources are published here with each tagged release, so every version on the Marketplace corresponds to a matching, buildable tag in this repository.

## Verify it yourself

```
pnpm install
pnpm --filter @awaitful/shared build
pnpm --filter extension build
```

To reproduce the packaged extension:

```
pnpm --filter extension exec vsce package --no-dependencies
```

The SHA-256 of each published build is recorded under `releases/`. Compare it against the extension you installed to confirm they match.

## What leaves your machine

Read `PRIVACY.md` for the exact list. In short: a device token plus coarse, opt-in signals, and nothing else. The `shared` contract above is the machine-checkable proof of that - there is no field in which your code or prompts could travel.

## License

MIT. See `LICENSE`.
