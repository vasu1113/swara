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

const ariaHtml = readFileSync(resolve(here, '../../demo/google-form-clone.html'), 'utf8');
const ariaDom = new JSDOM(ariaHtml, { url: 'https://docs.google.test/forms/example' });
Object.defineProperty(ariaDom.window.HTMLElement.prototype, 'offsetParent', {
  configurable: true,
  get(this: HTMLElement) {
    return ariaDom.window.document.body;
  },
});
Object.defineProperty(ariaDom.window.HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value() {},
});

g.window = ariaDom.window;
g.document = ariaDom.window.document;
g.location = ariaDom.window.location;
g.Event = ariaDom.window.Event;
for (const ctor of [
  'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement',
  'HTMLAnchorElement',
  'HTMLLabelElement', 'HTMLLegendElement', 'HTMLElement', 'Element',
]) {
  g[ctor] = (ariaDom.window as unknown as Record<string, unknown>)[ctor];
}

const ariaDoc = ariaDom.window.document;
let publicClicks = 0;
let typescriptClicks = 0;
const publicRadio = ariaDoc.querySelector<HTMLElement>('[role="radio"][data-value="public"]')!;
publicRadio.addEventListener('click', () => {
  publicClicks += 1;
  ariaDoc.querySelectorAll<HTMLElement>('[role="radio"]').forEach((radio) => {
    radio.setAttribute('aria-checked', String(radio === publicRadio));
  });
});
const typescriptCheckbox = ariaDoc.querySelector<HTMLElement>(
  '[role="checkbox"][data-answer-value="typescript"]',
)!;
typescriptCheckbox.addEventListener('click', () => {
  typescriptClicks += 1;
  typescriptCheckbox.setAttribute(
    'aria-checked',
    String(typescriptCheckbox.getAttribute('aria-checked') !== 'true'),
  );
});
const puneOption = ariaDoc.querySelector<HTMLElement>('[role="option"][aria-label="Pune"]')!;
puneOption.addEventListener('click', () => {
  puneOption.setAttribute('aria-selected', 'true');
});

const ariaResults = executeActions([
  { fieldId: 'candidate-name', action: 'fill', value: 'Ada Lovelace' },
  { fieldId: 'commute', action: 'select', value: 'public' },
  { fieldId: 'skills', action: 'check', value: 'typescript' },
  { fieldId: 'skills', action: 'uncheck', value: 'typescript' },
  { fieldId: 'office-location', action: 'select', value: 'Pune' },
]);

console.log('\nARIA executor');

check('still fills a native input on a mixed ARIA page', () => {
  assert.equal(
    ariaDoc.querySelector<HTMLInputElement>('#candidate-name')!.value,
    'Ada Lovelace',
  );
});

check('clicks the matching ARIA radio option', () => {
  assert.equal(publicClicks, 1);
  assert.equal(publicRadio.getAttribute('aria-checked'), 'true');
});

check('does not click an already-checked ARIA checkbox', () => {
  assert.equal(typescriptClicks, 1, 'only the later uncheck should click');
});

check('clicks an ARIA checkbox to uncheck it', () => {
  assert.equal(typescriptCheckbox.getAttribute('aria-checked'), 'false');
});

check('clicks the matching ARIA listbox option', () => {
  assert.equal(puneOption.getAttribute('aria-selected'), 'true');
  assert.equal(ariaResults.every((result) => result.ok), true, JSON.stringify(ariaResults));
});

const gmailDom = new JSDOM(
  `<!doctype html>
  <html>
    <body>
      <div
        id="reply-editor"
        role="textbox"
        contenteditable="true"
        aria-label="Message body"
      >Existing draft</div>
      <button id="send-email">Send</button>
    </body>
  </html>`,
  { url: 'https://mail.google.test/mail/u/0/#inbox/thread' },
);
Object.defineProperty(gmailDom.window.HTMLElement.prototype, 'offsetParent', {
  configurable: true,
  get(this: HTMLElement) {
    return gmailDom.window.document.body;
  },
});
Object.defineProperty(gmailDom.window.HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value() {},
});

g.window = gmailDom.window;
g.document = gmailDom.window.document;
g.location = gmailDom.window.location;
g.Event = gmailDom.window.Event;
for (const ctor of [
  'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement',
  'HTMLAnchorElement',
  'HTMLLabelElement', 'HTMLLegendElement', 'HTMLElement', 'Element',
]) {
  g[ctor] = (gmailDom.window as unknown as Record<string, unknown>)[ctor];
}

const gmailDoc = gmailDom.window.document;
const editor = gmailDoc.querySelector<HTMLElement>('#reply-editor')!;
const editableEvents: string[] = [];
const editableValues: string[] = [];
for (const type of ['beforeinput', 'input', 'change']) {
  editor.addEventListener(type, () => {
    editableEvents.push(type);
    if (type === 'input') editableValues.push(editor.textContent ?? '');
  });
}

let sendClicks = 0;
gmailDoc
  .querySelector<HTMLButtonElement>('#send-email')!
  .addEventListener('click', () => {
    sendClicks += 1;
  });

const editableResults = executeActions([
  { fieldId: 'reply-editor', action: 'fill', value: 'Warm first draft' },
  { fieldId: 'reply-editor', action: 'clear', value: '' },
  { fieldId: 'Message body', action: 'fill', value: 'Final reply' },
  { fieldId: 'missing-editor', action: 'fill', value: 'Not inserted' },
  { fieldId: 'reply-editor', action: 'fill', value: 'Continued after failure' },
  { fieldId: 'send-email', action: 'click', value: '' },
]);

console.log('\ncontenteditable executor');

check('fills and replaces a Gmail-like contenteditable editor', () => {
  assert.equal(editor.textContent, 'Continued after failure');
  assert.ok(
    editableValues.includes('Warm first draft'),
    `editable values: ${editableValues.join(', ')}`,
  );
  assert.ok(
    editableValues.includes('Final reply'),
    `editable values: ${editableValues.join(', ')}`,
  );
});

check('clears a contenteditable editor', () => {
  assert.equal(editableResults[1].ok, true);
  assert.ok(
    editableValues.includes(''),
    `editable values: ${editableValues.join(', ')}`,
  );
});

check('dispatches rich-editor lifecycle events', () => {
  assert.ok(editableEvents.includes('beforeinput'));
  assert.ok(editableEvents.includes('input'));
  assert.ok(editableEvents.includes('change'));
});

check('continues contenteditable actions after one failure', () => {
  assert.equal(editableResults[3].ok, false);
  assert.match(editableResults[3].error ?? '', /not found/i);
  assert.equal(editableResults[4].ok, true);
  assert.equal(editor.textContent, 'Continued after failure');
});

check('refuses to click Send beside a rich editor', () => {
  assert.deepEqual(editableResults[5], {
    fieldId: 'send-email',
    ok: false,
    error: 'Refused: submitting is left to you.',
  });
  assert.equal(sendClicks, 0);
});

const { ASSISTANT_FEATURES } = await import('../src/features.ts');
const mutableFeatures = ASSISTANT_FEATURES as unknown as Record<string, boolean>;
mutableFeatures.contentEditableFill = false;
const gatedEditableResult = executeActions([
  { fieldId: 'reply-editor', action: 'fill', value: 'Must not appear' },
]);
mutableFeatures.contentEditableFill = true;

check('contenteditable execution is refused when its feature is disabled', () => {
  assert.equal(gatedEditableResult[0].ok, false);
  assert.equal(editor.textContent, 'Continued after failure');
});

const duplicateOne = document.createElement('div');
duplicateOne.setAttribute('role', 'textbox');
duplicateOne.setAttribute('contenteditable', 'true');
duplicateOne.setAttribute('aria-label', 'Duplicate Body');
const duplicateTwo = duplicateOne.cloneNode() as HTMLElement;
document.body.append(duplicateOne, duplicateTwo);
const ambiguousResult = executeActions([
  { fieldId: 'Duplicate Body', action: 'fill', value: 'Wrong target' },
]);

check('refuses an ambiguous rich-editor label', () => {
  assert.equal(ambiguousResult[0].ok, false);
  assert.equal(duplicateOne.textContent, '');
  assert.equal(duplicateTwo.textContent, '');
});

console.log(
  failures.length === 0
    ? '\nAll executor checks passed.\n'
    : `\n${failures.length} check(s) failed.\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
