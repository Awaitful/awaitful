import type * as vscode from 'vscode';
import type { PlacementId } from '@awaitful/shared';

const KEY = (id: string) => `awaitful.consent.${id}`;

export class ConsentStore {
  constructor(private readonly state: vscode.ExtensionContext['globalState']) {}

  isGranted(id: PlacementId): boolean {
    return this.state.get<boolean>(KEY(id)) === true;
  }

  async grant(id: PlacementId): Promise<void> {
    await this.state.update(KEY(id), true);
  }

  async revoke(id: PlacementId): Promise<void> {
    await this.state.update(KEY(id), undefined);
  }

  async revokeAll(): Promise<void> {
    const ids: PlacementId[] = ['status-bar', 'thinking-line', 'terminal', 'browser', 'chat-banner'];
    await Promise.all(ids.map((id) => this.state.update(KEY(id), undefined)));
  }
}
