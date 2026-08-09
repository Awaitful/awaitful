# Security policy

Awaitful runs inside people's editors and moves real money, so security reports get read with
attention and gratitude. If you think you have found a vulnerability, we want to hear about it.

## Reporting

Email **security@awaitful.com**. A machine-readable contact lives at
[awaitful.com/.well-known/security.txt](https://awaitful.com/.well-known/security.txt).

Helpful in a report:

- What you found and where (the extension, the API at awaitful.com, the web dashboard, or the
  npx installer).
- Steps to reproduce, or a proof of concept.
- What you think the impact is. If it touches money movement, the ledger, or anything that
  leaves a developer's machine, say so - those reports go first.

We acknowledge every report within 2 to 3 business days, then tell you honestly what we conclude
and what we change. We do not currently run a paid bounty program, and we will not pretend
otherwise; credit in the changelog is yours if you want it.

## Scope

- The `awaitful.awaitful` VS Code extension and the `awaitful` npm installer (this repository).
- The API and web dashboard at awaitful.com.

The most sensitive properties, in order: nothing may read code, prompts, or files from a
developer's machine (see [PRIVACY.md](./PRIVACY.md) - the egress list is enforced by a CI test);
the editor must never be left broken by the patch engine; and no event may bill or pay twice.

## Safe harbor

Research done in good faith, within the lines below, is authorized. We will not bring or support
legal action over it - including under the Computer Fraud and Abuse Act, the DMCA's
anti-circumvention rules, or our terms of service - and we will not ask anyone else to. If a
third party pursues you for work that stayed inside this policy, we will say plainly that it was
authorized.

Good faith means: only access or change data that is your own, do not degrade the service for
others (no denial of service, no spam), do not social-engineer people, test against your own
accounts and machines, and give us a reasonable window to fix what you find before you publish.
If you are unsure whether something is in scope, ask at security@awaitful.com first - the question
itself is treated as good faith.
