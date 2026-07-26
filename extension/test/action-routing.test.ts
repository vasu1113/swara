import assert from 'node:assert/strict';

import type { Action } from '../src/types';
import {
  executeRoutedActions,
  safeNavigationUrl,
} from '../src/sidepanel/actionRouting';

const domActions: Action[][] = [];
const openedUrls: string[] = [];
const actions: Action[] = [
  { fieldId: 'full_name', action: 'fill', value: 'Vasu' },
  { fieldId: 'browser:new', action: 'open_url', value: 'https://example.com/research?q=swara' },
  { fieldId: 'about', action: 'fill', value: 'Builder' },
  { fieldId: 'browser:bad', action: 'open_url', value: 'javascript:alert(1)' },
];

const results = await executeRoutedActions(actions, {
  allowOpenUrl: true,
  executeDomActions: async (batch) => {
    domActions.push(batch);
    return batch.map((action) => ({ fieldId: action.fieldId, ok: true }));
  },
  openTab: async (url) => {
    openedUrls.push(url);
  },
});

assert.deepEqual(
  domActions[0].map((action) => action.fieldId),
  ['full_name', 'about'],
  'navigation must never enter the content-script batch',
);
assert.deepEqual(openedUrls, ['https://example.com/research?q=swara']);
assert.deepEqual(results.map((result) => result.ok), [true, true, true, false]);
assert.match(results[3].error ?? '', /http and https/i);
assert.throws(() => safeNavigationUrl('https://user:secret@example.com'), /credential-free/i);
assert.throws(() => safeNavigationUrl('/relative'), /complete http or https/i);

const isolated = await executeRoutedActions(
  [
    { fieldId: 'name', action: 'fill', value: 'Vasu' },
    { fieldId: 'browser:new', action: 'open_url', value: 'https://example.com' },
  ],
  {
    allowOpenUrl: true,
    executeDomActions: async () => {
      throw new Error('content script unavailable');
    },
    openTab: async () => undefined,
  },
);
assert.equal(isolated[0].ok, false);
assert.equal(isolated[1].ok, true, 'DOM failure must not abort navigation');

const disabled = await executeRoutedActions(
  [{ fieldId: 'browser:new', action: 'open_url', value: 'https://example.com' }],
  {
    allowOpenUrl: false,
    executeDomActions: async () => [],
    openTab: async () => {
      throw new Error('must not be called');
    },
  },
);
assert.equal(disabled[0].ok, false);
assert.match(disabled[0].error ?? '', /disabled/i);

console.log('All action-routing checks passed.');
