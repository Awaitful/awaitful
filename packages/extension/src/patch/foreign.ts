import * as fs from 'node:fs';
import * as path from 'node:path';
import { extensionsRoot } from './targets.js';

/**
 * Detect whether Claude Code has been modified by another extension, and best-effort
 * NAME the responsible extension — a vague "another extension" reads as a false
 * positive; a named one is actionable ("Acme is modifying Claude Code").
 *
 * We hardcode no tool names. Attribution is generic, from two fingerprints another
 * extension leaves behind:
 *   1. an in-file patch marker it wrapped its injection in (a `NAME-START` … `NAME-END`
 *      comment), read straight out of the file we refuse to touch — the strongest, most
 *      direct signal, and present even when the tool kept its backup elsewhere; and
 *   2. a sibling backup of the original it saved next to the target
 *      ("index.js.NAME-backup"), which also doubles as a verified-pristine source.
 * The safety decision (patch or not) is still made purely by hash elsewhere; this
 * module only supplies presence + a human name + an optional pristine source.
 */

export interface ForeignDetection {
  /** Another extension's fingerprint was found (in-file marker or sibling backup). */
  present: boolean;
  /** Display name of the responsible extension, when it can be resolved. */
  vendor?: string;
  /** Path to the sibling backup, if any (a verified-pristine source for take-over). */
  backupPath?: string;
}

// Our own transient/owned filenames must never be treated as another extension's backup.
const OURS = ['.awaitful-tmp'];
// Trailing words commonly appended to a backup filename; stripping them leaves a
// name token (e.g. "index.js.acme-backup" → "acme").
const BACKUP_WORDS = /[.\-_](backup|bak|orig|original|save|old)$/i;

// A foreign patch tool's block marker, e.g. "/* ACME-START v3 */" or "/* OTHERTOOL-START".
// We capture the NAME token generically and never enumerate specific tools; our own marker
// (AWAITFUL) is skipped so we never attribute our own patch to a "competitor".
const FOREIGN_MARKER = /\/\*\s*([A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*)[-_](?:START|BEGIN)\b/g;
const OUR_MARKER_TOKEN = 'awaitful';

/**
 * Detect a foreign modification of `targetFile`. Pass the file's `content` (callers have
 * usually already read it) to enable the strongest signal — the in-file patch marker;
 * without it, only the sibling-backup scan runs. Never throws.
 */
export function detectForeign(targetFile: string, content?: string): ForeignDetection {
  const markerToken = content ? foreignMarkerToken(content) : undefined;
  const sibling = siblingBackup(targetFile);

  if (!sibling.present && !markerToken) return { present: false };

  // Resolve a real name: the backup token first (it may be an old product name a manifest
  // scan can map), then the in-file marker. Either resolves through installed extensions.
  const vendor = sibling.vendor ?? (markerToken ? resolveVendorName(markerToken) : undefined);
  const out: ForeignDetection = { present: true };
  if (vendor) out.vendor = vendor;
  if (sibling.backupPath) out.backupPath = sibling.backupPath;
  return out;
}

/** First foreign patch marker's NAME token found in the file, excluding our own. */
function foreignMarkerToken(content: string): string | undefined {
  FOREIGN_MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FOREIGN_MARKER.exec(content)) !== null) {
    const token = m[1];
    if (token && token.toLowerCase() !== OUR_MARKER_TOKEN) return token;
  }
  return undefined;
}

/** Look for a sibling backup of the target and derive which extension made it. Never throws. */
function siblingBackup(targetFile: string): ForeignDetection {
  const dir = path.dirname(targetFile);
  const base = path.basename(targetFile);

  let siblings: string[];
  try {
    siblings = fs.readdirSync(dir);
  } catch {
    return { present: false };
  }

  for (const name of siblings) {
    if (name === base) continue;
    if (!name.startsWith(base + '.')) continue;         // must be `<target>.<suffix>`
    if (OURS.some((o) => name.endsWith(o))) continue;    // skip our own files
    const suffix = name.slice(base.length);              // e.g. ".acme-backup"
    if (!BACKUP_WORDS.test(suffix)) continue;            // must look like a backup

    const token = suffix.replace(/^[.\-_]/, '').replace(BACKUP_WORDS, '').trim();
    const vendor = resolveVendorName(token);
    const backupPath = path.join(dir, name);
    return vendor
      ? { present: true, vendor, backupPath }
      : { present: true, backupPath };
  }

  return { present: false };
}

/**
 * Resolve a backup-filename token (e.g. "acme") to an installed extension's
 * display name by scanning the user's own extensions directory — so the name we
 * show is real and current, never hardcoded. Returns undefined if the token is
 * empty/generic or no installed extension matches.
 */
function resolveVendorName(token: string): string | undefined {
  if (token.length < 3) return undefined; // too short/generic to trust

  let dirs: string[];
  try {
    dirs = fs.readdirSync(extensionsRoot());
  } catch {
    return titleCase(token);
  }

  const needle = token.toLowerCase();
  const candidates = dirs.filter((d) => {
    const low = d.toLowerCase();
    return !low.startsWith('anthropic.claude-code-') && !low.startsWith('awaitful');
  });

  const displayName = (d: string): string | undefined => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(extensionsRoot(), d, 'package.json'), 'utf8'));
      const name = pkg.displayName || pkg.name;
      return typeof name === 'string' && name.trim() ? name.trim() : undefined;
    } catch {
      return undefined;
    }
  };

  // 1. Match by directory name (publisher.name-version) — fast and precise.
  for (const d of candidates) {
    if (d.toLowerCase().includes(needle)) return displayName(d) ?? titleCase(token);
  }

  // 2. Match by manifest CONTENT — catches a backup suffix that is an old product
  //    name (e.g. ".acme-classic-backup" left by an extension since renamed to "Acme",
  //    whose package.json still mentions "acme-classic"). Still fully generic.
  for (const d of candidates) {
    try {
      const raw = fs.readFileSync(path.join(extensionsRoot(), d, 'package.json'), 'utf8');
      if (raw.toLowerCase().includes(needle)) {
        const name = displayName(d);
        if (name) return name;
      }
    } catch {
      /* ignore and keep scanning */
    }
  }

  return titleCase(token);
}

function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
