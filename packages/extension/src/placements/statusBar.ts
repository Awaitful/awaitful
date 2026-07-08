import type { Availability, Creative, PlacementContext } from '@awaitful/shared';
import type { StatusBarUI } from '../ui/statusBar.js';

export class StatusBarPlacement {
  readonly id = 'status-bar' as const;
  readonly requiresConsent = false;

  private ctx: PlacementContext | undefined;

  constructor(
    private readonly ui: StatusBarUI,
    /** Supplies the idle earnings label/tooltip so returning to idle after an ad shows it too. */
    private readonly getEarning: () => { amount?: string; tooltip?: string } | undefined = () => undefined,
  ) {}

  detect(): Promise<Availability> {
    return Promise.resolve({ status: 'available' });
  }

  activate(ctx: PlacementContext): Promise<void> {
    this.ctx = ctx;
    return Promise.resolve();
  }

  deactivate(): Promise<void> {
    this.ctx = undefined;
    return Promise.resolve();
  }

  show(creative: Creative): void {
    this.ui.showAd(creative.line, !!creative.url);
    this.ctx?.show(creative);
  }

  hide(): void {
    this.ui.setState('earning', this.getEarning());
    this.ctx?.hide();
  }
}
