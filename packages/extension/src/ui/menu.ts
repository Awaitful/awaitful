import * as vscode from 'vscode';

export type MenuActions = {
  openPanel(): void;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  enable(): void;
  disable(): void;
  openDashboard(): Promise<void>;
  about(): void;
  visitAd(): void;
  reloadWindow(): void;
};

export function registerCommands(
  context: vscode.ExtensionContext,
  actions: MenuActions,
): void {
  const cmd = (id: string, fn: () => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd('awaitful.menu',          () => actions.openPanel());
  cmd('awaitful.openPanel',     () => actions.openPanel());
  cmd('awaitful.signIn',        () => actions.signIn());
  cmd('awaitful.signOut',       () => actions.signOut());
  cmd('awaitful.enable',        () => actions.enable());
  cmd('awaitful.disable',       () => actions.disable());
  cmd('awaitful.openDashboard', () => actions.openDashboard());
  cmd('awaitful.about',         () => actions.about());
  cmd('awaitful.visitAd',       () => actions.visitAd());
  cmd('awaitful.reload',        () => actions.reloadWindow());
}
