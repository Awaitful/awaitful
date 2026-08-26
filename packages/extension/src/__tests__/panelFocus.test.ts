import { describe, it, expect } from 'vitest';
import { src, stripComments, methodBody } from './sourceGuard.js';

/**
 * The panel must never take the tab while the developer is working.
 *
 * `syncPanel()` runs on 35 different occasions - every thinking tick, every account refresh, every
 * presence change - and it used to reach the open panel through `openOrReveal`, which reveals. So
 * the panel hauled its own tab to the front of its group again and again: someone talking to their
 * agent watched the settings tab replace whatever they were reading, with no window reload and
 * nothing asked for. Delivering state and asking for attention are different acts, and the whole fix
 * is that they no longer share a door.
 */

describe('the panel does not steal the tab', () => {
  it('delivers routine state updates without revealing', () => {
    const body = methodBody(src('core/orchestrator.ts'), 'private syncPanel(): void');
    expect(body, 'syncPanel reveals the panel on every state change').not.toContain('openOrReveal');
    expect(body).toContain('AwaitfulPanel.update');
  });

  // The quiet path has to STAY quiet: if update ever learns to reveal, every one of those 35 calls
  // starts pulling the tab forward again and the guard above would still pass.
  it('keeps the update path free of any reveal', () => {
    const body = methodBody(src('ui/panel.ts'), 'static update(state: PanelState): void');
    expect(body).not.toContain('reveal');
  });

  /**
   * One door for attention. A second `reveal` anywhere in the panel is a second way for a tab to
   * jump, and the next one will not be found by reading this file.
   */
  it('has exactly one reveal, inside openOrReveal', () => {
    const source = stripComments(src('ui/panel.ts'));
    expect(source.match(/\.reveal\(/g) ?? []).toHaveLength(1);
    expect(methodBody(source, 'static openOrReveal(')).toContain('.reveal(');
  });

  /**
   * Revealing into the ACTIVE column drags the tab across the window to wherever the developer is
   * working. Even when the reveal is wanted, moving the panel out of the column it lives in is a
   * second surprise on top of the first.
   */
  it('reveals the panel where it already lives, not where the cursor is', () => {
    const body = methodBody(src('ui/panel.ts'), 'static openOrReveal(');
    expect(body).toContain('.reveal(AwaitfulPanel.instance.panel.viewColumn');
    expect(body).not.toContain('.reveal(vscode.ViewColumn.Active');
  });
});
