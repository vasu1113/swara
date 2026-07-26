import type { Action, ActionResult } from '../types';

export type ActionRoutingDependencies = {
  executeDomActions: (actions: Action[]) => Promise<ActionResult[]>;
  openTab: (url: string) => Promise<void>;
  allowOpenUrl: boolean;
};

export function safeNavigationUrl(value: string): string {
  const candidate = value.trim();
  if (!candidate || candidate.length > 2_048) {
    throw new Error('Navigation requires a valid URL.');
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('Navigation requires a complete http or https URL.');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only credential-free http and https URLs can be opened.');
  }
  return url.toString();
}

/**
 * Keep browser actions out of the content script. DOM actions retain their
 * existing batched execution path; navigation failures are isolated to their
 * own result and cannot abort form filling.
 */
export async function executeRoutedActions(
  actions: Action[],
  dependencies: ActionRoutingDependencies,
): Promise<ActionResult[]> {
  const results = new Array<ActionResult>(actions.length);
  const domEntries = actions
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => action.action !== 'open_url');

  if (domEntries.length) {
    try {
      const domResults = await dependencies.executeDomActions(
        domEntries.map(({ action }) => action),
      );
      domEntries.forEach(({ action, index }, resultIndex) => {
        results[index] = domResults[resultIndex] ?? {
          fieldId: action.fieldId,
          ok: false,
          error: 'The page did not return an action result.',
        };
      });
    } catch (error) {
      domEntries.forEach(({ action, index }) => {
        results[index] = {
          fieldId: action.fieldId,
          ok: false,
          error: error instanceof Error ? error.message : 'Could not change this page.',
        };
      });
    }
  }

  for (const { action, index } of actions
    .map((action, actionIndex) => ({ action, index: actionIndex }))
    .filter(({ action }) => action.action === 'open_url')) {
    try {
      if (!dependencies.allowOpenUrl) {
        throw new Error('Opening pages is disabled for this page session.');
      }
      await dependencies.openTab(safeNavigationUrl(action.value));
      results[index] = { fieldId: action.fieldId, ok: true };
    } catch (error) {
      results[index] = {
        fieldId: action.fieldId,
        ok: false,
        error: error instanceof Error ? error.message : 'Could not open the page.',
      };
    }
  }

  return results;
}
