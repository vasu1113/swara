import type {
  FieldOption,
  FieldType,
  FormField,
  PageContext,
} from '../types';

export type FormControlElement =
  | HTMLInputElement
  | HTMLTextAreaElement
  | HTMLSelectElement;

export type ExtractableFieldTarget = {
  fieldId: string;
  type: FieldType;
  elements: FormControlElement[];
};

const TEXT_INPUT_TYPES = new Set([
  'text',
  'email',
  'tel',
  'url',
  'search',
  'number',
  'password',
]);

function isRendered(element: HTMLElement): boolean {
  return (
    element.offsetParent !== null ||
    window.getComputedStyle(element).position === 'fixed'
  );
}

export function isExtractableControl(
  element: Element,
): element is FormControlElement {
  if (
    !(
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) ||
    element.disabled ||
    !isRendered(element)
  ) {
    return false;
  }

  return (
    !(element instanceof HTMLInputElement) ||
    TEXT_INPUT_TYPES.has(element.type) ||
    element.type === 'radio' ||
    element.type === 'checkbox'
  );
}

function controlType(element: FormControlElement): FieldType {
  if (element instanceof HTMLTextAreaElement) {
    return 'textarea';
  }
  if (element instanceof HTMLSelectElement) {
    return 'select';
  }
  if (element.type === 'radio') {
    return 'radio';
  }
  if (element.type === 'checkbox') {
    return 'checkbox';
  }
  return 'text';
}

export function collectExtractableFieldTargets(): ExtractableFieldTarget[] {
  const controls = Array.from(
    document.querySelectorAll('input, textarea, select'),
  ).filter(isExtractableControl);
  const targets: ExtractableFieldTarget[] = [];
  const seenGroups = new Set<string>();

  for (const control of controls) {
    const type = controlType(control);
    if (
      control instanceof HTMLInputElement &&
      (type === 'radio' || type === 'checkbox')
    ) {
      const name = control.name;
      const groupKey = name ? `${type}:${name}` : '';
      if (groupKey && seenGroups.has(groupKey)) {
        continue;
      }
      if (groupKey) {
        seenGroups.add(groupKey);
      }

      const elements = name
        ? controls.filter(
            (candidate): candidate is HTMLInputElement =>
              candidate instanceof HTMLInputElement &&
              candidate.type === type &&
              candidate.name === name,
          )
        : [control];
      const index = targets.length;
      targets.push({
        fieldId: name || `input:${index}`,
        type,
        elements,
      });
      continue;
    }

    const index = targets.length;
    targets.push({
      fieldId:
        control.id ||
        control.getAttribute('name') ||
        `${control.tagName.toLowerCase()}:${index}`,
      type,
      elements: [control],
    });
  }

  return targets;
}

function collapseText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/[\s*:]+$/, '');
}

function cleanElementText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  clone
    .querySelectorAll('[aria-hidden="true"], span.hint')
    .forEach((node) => node.remove());
  clone.querySelectorAll('span').forEach((span) => {
    if (/^\s*\([^)]*\)\s*$/.test(span.textContent ?? '')) {
      span.remove();
    }
  });
  return collapseText(clone.textContent ?? '');
}

function labelForId(id: string): HTMLLabelElement | undefined {
  if (!id) {
    return undefined;
  }
  return Array.from(
    document.querySelectorAll<HTMLLabelElement>('label[for]'),
  ).find(
    (label) => label.htmlFor === id,
  );
}

function resolveLabel(control: FormControlElement): string {
  const explicitLabel = labelForId(control.id);
  if (explicitLabel) {
    return cleanElementText(explicitLabel);
  }

  const wrappingLabel = control.closest('label');
  if (wrappingLabel) {
    return cleanElementText(wrappingLabel);
  }

  const ariaLabel = control.getAttribute('aria-label');
  if (ariaLabel) {
    return collapseText(ariaLabel);
  }

  const labelledBy = control.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null)
      .map(cleanElementText)
      .filter(Boolean)
      .join(' ');
    if (text) {
      return collapseText(text);
    }
  }

  return collapseText(control.getAttribute('placeholder') ?? '');
}

function directLegend(control: HTMLInputElement): HTMLLegendElement | undefined {
  const fieldset = control.closest('fieldset');
  return Array.from(fieldset?.children ?? []).find(
    (child): child is HTMLLegendElement =>
      child instanceof HTMLLegendElement,
  );
}

function humanizeName(name: string): string {
  const text = collapseText(name.replace(/[_-]+/g, ' '));
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : 'Selection';
}

function sharedLabelPrefix(options: FieldOption[]): string {
  if (options.length === 0) {
    return '';
  }
  if (options.length === 1) {
    return options[0].label;
  }

  const wordLists = options.map((option) => option.label.split(/\s+/));
  const prefix: string[] = [];
  for (let index = 0; index < wordLists[0].length; index += 1) {
    const word = wordLists[0][index];
    if (
      wordLists.every(
        (words) => words[index]?.toLocaleLowerCase() === word.toLocaleLowerCase(),
      )
    ) {
      prefix.push(word);
    } else {
      break;
    }
  }
  return collapseText(prefix.join(' ').replace(/[-–—,]+$/, ''));
}

function groupQuestion(
  control: HTMLInputElement,
  options: FieldOption[],
): string {
  const legend = directLegend(control);
  if (legend) {
    const text = cleanElementText(legend);
    if (text) {
      return text;
    }
  }
  return sharedLabelPrefix(options) || humanizeName(control.name);
}

function selectOptions(select: HTMLSelectElement): FieldOption[] {
  return Array.from(select.options)
    .filter((option) => !(option.disabled && option.value === ''))
    .map((option) => ({
      value: option.value,
      label: collapseText(option.textContent ?? option.label),
    }));
}

function optionalAttributes(
  control: FormControlElement,
): Pick<FormField, 'placeholder' | 'maxLength'> {
  const attributes: Pick<FormField, 'placeholder' | 'maxLength'> = {};
  if (
    (control instanceof HTMLInputElement ||
      control instanceof HTMLTextAreaElement) &&
    control.hasAttribute('placeholder')
  ) {
    attributes.placeholder = control.placeholder;
  }

  if (
    (control instanceof HTMLInputElement ||
      control instanceof HTMLTextAreaElement) &&
    control.hasAttribute('maxlength')
  ) {
    const maxLength = Number(control.getAttribute('maxlength'));
    if (Number.isFinite(maxLength)) {
      attributes.maxLength = maxLength;
    }
  }
  return attributes;
}

function isRequired(control: FormControlElement): boolean {
  return (
    control.required ||
    control.getAttribute('aria-required')?.toLocaleLowerCase() === 'true'
  );
}

function fieldFromTarget(target: ExtractableFieldTarget): FormField {
  const first = target.elements[0];
  if (
    (target.type === 'radio' || target.type === 'checkbox') &&
    first instanceof HTMLInputElement
  ) {
    const inputs = target.elements.filter(
      (element): element is HTMLInputElement =>
        element instanceof HTMLInputElement,
    );
    const options = inputs.map((input) => ({
      value: input.value,
      label: resolveLabel(input),
    }));
    const question = groupQuestion(first, options);
    return {
      fieldId: target.fieldId,
      label: question,
      question,
      type: target.type,
      required: inputs.some(isRequired),
      options,
      currentValue: inputs
        .filter((input) => input.checked)
        .map((input) => input.value)
        .join(', '),
    };
  }

  const label = resolveLabel(first);
  return {
    fieldId: target.fieldId,
    label,
    question: label,
    type: target.type,
    required: isRequired(first),
    options:
      first instanceof HTMLSelectElement ? selectOptions(first) : [],
    ...optionalAttributes(first),
    currentValue: first.value,
  };
}

export function extractPage(): PageContext {
  const headingElement = document.querySelector('h1');
  return {
    url: location.href,
    title: document.title,
    ...(headingElement
      ? { heading: cleanElementText(headingElement) }
      : {}),
    fields: collectExtractableFieldTargets().map(fieldFromTarget),
  };
}
