/**
 * Runs the real executor against the job-application fixture in jsdom.
 *
 * Filling is the part of the demo that must not fail live, so this asserts the
 * DOM actually changed and that framework-facing events were dispatched.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '../../demo/job-application.html'), 'utf8');
const dom = new JSDOM(html, { url: 'https://example.test/job' });

Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', {
  configurable: true,
  get(this: HTMLElement) {
    for (let node: HTMLElement | null = this; node; node = node.parentElement) {
      if (dom.window.getComputedStyle(node).display === 'none') return null;
    }
    return dom.window.document.body;
  },
});

const scrolledElements: HTMLElement[] = [];
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value(this: HTMLElement) {
    scrolledElements.push(this);
  },
});

const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.location = dom.window.location;
g.Event = dom.window.Event;
for (const ctor of [
  'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement',
  'HTMLAnchorElement',
  'HTMLLabelElement', 'HTMLLegendElement', 'HTMLElement', 'Element',
]) {
  g[ctor] = (dom.window as unknown as Record<string, unknown>)[ctor];
}

const { executeActions } = await import('../src/content/execute.ts');
const doc = dom.window.document;

// Record events the way a React onChange handler would see them.
const seen: string[] = [];
for (const type of ['input', 'change']) {
  doc.addEventListener(type, (e) => {
    seen.push(`${type}:${(e.target as HTMLElement).id || (e.target as HTMLInputElement).name}`);
  });
}

const failures: string[] = [];
function check(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(label);
    console.log(`  FAIL ${label}\n       ${(error as Error).message}`);
  }
}

const results = executeActions([
  { fieldId: 'full_name', action: 'fill', value: 'Vasu Yogeshwar' },
  { fieldId: 'about_yourself', action: 'fill', value: 'I build AI products.' },
  { fieldId: 'years_of_experience', action: 'select', value: '4-6' },
  { fieldId: 'work_authorization', action: 'select', value: 'yes' },
  { fieldId: 'areas_of_interest', action: 'check', value: 'ml' },
  { fieldId: 'no_such_field', action: 'fill', value: 'x' },
]);

let saveDraftClicks = 0;
doc.querySelector<HTMLButtonElement>('.save-draft')!.addEventListener('click', () => {
  saveDraftClicks += 1;
});
const controlResults = executeActions([
  { fieldId: 'control:2', action: 'click', value: '' },
  { fieldId: 'control:3', action: 'click', value: '' },
]);

console.log('\nexecutor');

check('fills a text input', () => {
  assert.equal(doc.querySelector<HTMLInputElement>('#full_name')!.value, 'Vasu Yogeshwar');
});

check('fills a textarea', () => {
  assert.equal(doc.querySelector<HTMLTextAreaElement>('#about_yourself')!.value, 'I build AI products.');
});

check('selects a dropdown option by value', () => {
  const el = doc.querySelector<HTMLSelectElement>('#years_of_experience')!;
  assert.equal(el.value, '4-6', `select value was ${el.value}`);
});

check('checks the right radio in a group', () => {
  const checked = doc.querySelectorAll<HTMLInputElement>('input[name="work_authorization"]:checked');
  assert.equal(checked.length, 1);
  assert.equal(checked[0].value, 'yes');
});

check('checks one checkbox in a group without touching siblings', () => {
  const checked = [...doc.querySelectorAll<HTMLInputElement>('input[name="areas_of_interest"]:checked')];
  assert.deepEqual(checked.map((c) => c.value), ['ml']);
});

check('dispatches input and change so controlled inputs update', () => {
  assert.ok(seen.includes('input:full_name'), `events seen: ${seen.join(', ')}`);
  assert.ok(seen.includes('change:full_name'), `events seen: ${seen.join(', ')}`);
});

check('reports a per-action failure without aborting the batch', () => {
  assert.equal(results.length, 6);
  assert.equal(results.filter((r) => r.ok).length, 5);
  const bad = results.find((r) => r.fieldId === 'no_such_field')!;
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /not found/i);
});

check('clicks a non-submit control', () => {
  assert.equal(controlResults[0].ok, true);
  assert.equal(saveDraftClicks, 1);
  assert.equal(scrolledElements.includes(doc.querySelector('.save-draft')!), true);
});

check('refuses a submit-role control', () => {
  assert.deepEqual(controlResults[1], {
    fieldId: 'control:3',
    ok: false,
    error: 'Refused: submitting is left to you.',
  });
});

console.log(
  failures.length === 0
    ? '\nAll executor checks passed.\n'
    : `\n${failures.length} check(s) failed.\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
