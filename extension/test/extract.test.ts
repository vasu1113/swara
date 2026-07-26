/**
 * Runs the real extractor against the demo fixtures in jsdom.
 *
 * The extractor is pure DOM code with no Chrome APIs, so it can be exercised
 * outside the browser. Run with: npm test
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const demoDir = resolve(here, '../../demo');

async function loadFixture(name: string) {
  const html = readFileSync(resolve(demoDir, name), 'utf8');
  const dom = new JSDOM(html, { url: `https://example.test/${name}` });

  // jsdom does no layout, so offsetParent is always null and the extractor's
  // visibility guard would reject every control. Emulate layout: an element is
  // "rendered" unless it or an ancestor is display:none / hidden.
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      for (let node: HTMLElement | null = this; node; node = node.parentElement) {
        const style = dom.window.getComputedStyle(node);
        if (style.display === 'none' || node.hasAttribute('hidden')) return null;
      }
      return dom.window.document.body;
    },
  });

  // The extractor reads these as globals, exactly as it would in a content script.
  const g = globalThis as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.location = dom.window.location;
  for (const ctor of [
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLLabelElement',
    'HTMLLegendElement',
    'HTMLElement',
    'Element',
  ]) {
    g[ctor] = (dom.window as unknown as Record<string, unknown>)[ctor];
  }

  // Imported fresh per fixture so it binds the globals set above.
  const { extractPage } = await import(`../src/content/extract.ts?${name}`);
  return extractPage();
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

console.log('\njob-application.html');
const job = await loadFixture('job-application.html');
const jobById = new Map(job.fields.map((f: any) => [f.fieldId, f]));

check('extracts 13 logical fields', () => {
  assert.equal(job.fields.length, 13, `got ${job.fields.length}: ${job.fields.map((f: any) => f.fieldId).join(', ')}`);
});

check('groups the radio set into one field', () => {
  const counts = job.fields.reduce((acc: any, f: any) => ({ ...acc, [f.type]: (acc[f.type] ?? 0) + 1 }), {});
  assert.deepEqual(counts, { text: 5, textarea: 4, select: 2, radio: 1, checkbox: 1 }, JSON.stringify(counts));
});

check('strips the aria-hidden asterisk from labels', () => {
  const f = jobById.get('about_yourself');
  assert.ok(f, 'about_yourself missing');
  assert.equal(f.question, 'Tell us about yourself.');
  assert.ok(!f.question.includes('*'), 'asterisk leaked into the question');
});

check('drops the parenthetical hint from the phone label', () => {
  const f = jobById.get('phone');
  assert.ok(!/country code/i.test(f.question), `hint leaked: ${f.question}`);
});

check('uses the fieldset legend as the radio group question', () => {
  const f = jobById.get('work_authorization');
  assert.ok(f, 'work_authorization missing');
  assert.match(f.question, /legally authorized/i);
  assert.equal(f.options.length, 2);
});

check('uses the fieldset legend as the checkbox group question', () => {
  const f = jobById.get('areas_of_interest');
  assert.ok(f, 'areas_of_interest missing');
  assert.match(f.question, /areas of interest/i);
  assert.equal(f.options.length, 6, `got ${f.options.length} options`);
});

check('skips the placeholder option in selects', () => {
  const f = jobById.get('years_of_experience');
  assert.ok(f.options.length > 0);
  assert.ok(!f.options.some((o: any) => o.value === ''), 'empty placeholder option retained');
});

check('marks required fields', () => {
  assert.equal(jobById.get('full_name').required, true);
  assert.equal(jobById.get('linkedin_url').required, false);
});

check('omits maxLength when the attribute is unset', () => {
  const bogus = job.fields.filter((f: any) => f.maxLength === 524288);
  assert.equal(bogus.length, 0, 'leaked the DOM default maxLength');
});

check('captures the page heading', () => {
  assert.match(job.heading ?? '', /Senior AI Product Manager/i);
});

console.log('\nevent-registration.html');
const evt = await loadFixture('event-registration.html');
const evtById = new Map(evt.fields.map((f: any) => [f.fieldId, f]));

check('extracts 7 fields', () => {
  assert.equal(evt.fields.length, 7, `got ${evt.fields.length}: ${evt.fields.map((f: any) => f.fieldId).join(', ')}`);
});

check('treats the lone speaker checkbox as a checkbox field', () => {
  const f = evtById.get('speaker_interest');
  assert.ok(f, `speaker_interest missing; ids: ${[...evtById.keys()].join(', ')}`);
  assert.equal(f.type, 'checkbox');
});

check('every field has a non-empty question', () => {
  const blank = [...job.fields, ...evt.fields].filter((f: any) => !f.question.trim());
  assert.equal(blank.length, 0, `blank questions: ${blank.map((f: any) => f.fieldId).join(', ')}`);
});

console.log(
  failures.length === 0
    ? '\nAll extractor checks passed.\n'
    : `\n${failures.length} check(s) failed.\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
