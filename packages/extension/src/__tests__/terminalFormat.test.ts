import { describe, expect, it } from 'vitest';
import { formatTerminalLine } from '../core/terminalFormat.js';

const ESC = String.fromCharCode(27);

describe('formatTerminalLine', () => {
  it('renders a bold-green, marked line with no url', () => {
    const out = formatTerminalLine({ adId: 'a', slateId: 's', line: 'Deploy faster with Acme' });
    expect(out).toContain('Deploy faster with Acme');
    expect(out).toContain(`${ESC}[1;32m`); // bold + green (prominent, not dim)
    expect(out).not.toContain(`${ESC}[2m`); // never dim
    expect(out).toContain(`${ESC}[0m`); // reset
    expect(out).not.toContain(`${ESC}]8;;`); // no hyperlink
  });

  it('wraps the line in an OSC 8 hyperlink when a url is present', () => {
    const url = 'https://acme.example';
    const out = formatTerminalLine({ adId: 'a', slateId: 's', line: 'Try Acme', url });
    expect(out).toContain(`${ESC}]8;;${url}${ESC}\\`); // hyperlink open with the url
    expect(out).toContain('Try Acme');
    expect(out.endsWith(`${ESC}]8;;${ESC}\\`)).toBe(true); // hyperlink close
  });
});
