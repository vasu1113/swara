import type { Action, ActionResult } from '../types';
import {
  collectExtractableFieldTargets,
  isExtractableControl,
  type FormControlElement,
} from './extract';

type HighlightState = {
  outline: string;
  outlineOffset: string;
  timer: number;
};

const activeHighlights = new WeakMap<HTMLElement, HighlightState>();

function controlsWithName(name: string): FormControlElement[] {
  return Array.from(
    document.querySelectorAll('input, textarea, select'),
  ).filter(
    (element): element is FormControlElement =>
      isExtractableControl(element) &&
      element.getAttribute('name') === name,
  );
}

function resolveControls(fieldId: string): FormControlElement[] {
  const byId = document.getElementById(fieldId);
  if (byId && isExtractableControl(byId)) {
    return [byId];
  }

  const byName = controlsWithName(fieldId);
  if (byName.length > 0) {
    return byName;
  }

  const positional = collectExtractableFieldTargets().find(
    (target) => target.fieldId === fieldId,
  );
  return positional?.elements ?? [];
}

function focusAndBlur(
  element: FormControlElement,
  update: () => void,
): void {
  element.focus();
  try {
    update();
  } finally {
    element.blur();
  }
}

function dispatchValueEvents(element: FormControlElement): void {
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function setTextValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) {
    throw new Error('Native value setter is unavailable');
  }

  focusAndBlur(element, () => {
    setter.call(element, value);
    dispatchValueEvents(element);
  });
}

function setSelectValue(element: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    'value',
  )?.set;
  if (!setter) {
    throw new Error('Native select value setter is unavailable');
  }

  focusAndBlur(element, () => {
    setter.call(element, value);
    dispatchValueEvents(element);
  });
}

function setChecked(element: HTMLInputElement, checked: boolean): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'checked',
  )?.set;
  if (!setter) {
    throw new Error('Native checked setter is unavailable');
  }

  focusAndBlur(element, () => {
    // Clicking from the opposite state gives controlled frameworks their
    // expected click/input/change sequence while ending deterministically.
    setter.call(element, !checked);
    element.click();
    if (element.checked !== checked) {
      setter.call(element, checked);
      dispatchValueEvents(element);
    }
  });
}

function highlight(element: HTMLElement): void {
  const existing = activeHighlights.get(element);
  if (existing) {
    window.clearTimeout(existing.timer);
  }
  const outline = existing?.outline ?? element.style.outline;
  const outlineOffset = existing?.outlineOffset ?? element.style.outlineOffset;

  element.style.outline = '2px solid #7c3aed';
  element.style.outlineOffset = '2px';
  const timer = window.setTimeout(() => {
    element.style.outline = outline;
    element.style.outlineOffset = outlineOffset;
    activeHighlights.delete(element);
  }, 1200);
  activeHighlights.set(element, { outline, outlineOffset, timer });
}

function textControl(
  controls: FormControlElement[],
): HTMLInputElement | HTMLTextAreaElement | undefined {
  return controls.find(
    (control): control is HTMLInputElement | HTMLTextAreaElement =>
      control instanceof HTMLTextAreaElement ||
      (control instanceof HTMLInputElement &&
        control.type !== 'radio' &&
        control.type !== 'checkbox'),
  );
}

function matchingInput(
  controls: FormControlElement[],
  type: 'radio' | 'checkbox',
  value: string,
): HTMLInputElement | undefined {
  return controls.find(
    (control): control is HTMLInputElement =>
      control instanceof HTMLInputElement &&
      control.type === type &&
      control.value === value,
  );
}

function normalizedOptionLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function executeAction(
  controls: FormControlElement[],
  action: Action,
): HTMLElement {
  switch (action.action) {
    case 'fill':
    case 'clear': {
      const control = textControl(controls);
      if (!control) {
        throw new Error(`${action.action} requires a text input or textarea`);
      }
      setTextValue(control, action.action === 'clear' ? '' : action.value);
      return control;
    }

    case 'select': {
      const select = controls.find(
        (control): control is HTMLSelectElement =>
          control instanceof HTMLSelectElement,
      );
      if (select) {
        const availableOptions = Array.from(select.options).filter(
          (option) => !(option.disabled && option.value === ''),
        );
        const option =
          availableOptions.find((candidate) => candidate.value === action.value) ??
          availableOptions.find(
            (candidate) =>
              normalizedOptionLabel(
                candidate.textContent ?? candidate.label,
              ) === normalizedOptionLabel(action.value),
          );
        if (!option) {
          throw new Error(`Select option "${action.value}" was not found`);
        }
        setSelectValue(select, option.value);
        return select;
      }

      const radio = matchingInput(controls, 'radio', action.value);
      if (!radio) {
        throw new Error(`Radio option "${action.value}" was not found`);
      }
      setChecked(radio, true);
      return radio;
    }

    case 'check':
    case 'uncheck': {
      const checkbox = matchingInput(controls, 'checkbox', action.value);
      if (!checkbox) {
        throw new Error(`Checkbox option "${action.value}" was not found`);
      }
      setChecked(checkbox, action.action === 'check');
      return checkbox;
    }
  }
}

export function executeActions(actions: Action[]): ActionResult[] {
  return actions.map((action) => {
    try {
      const controls = resolveControls(action.fieldId);
      if (controls.length === 0) {
        throw new Error(`Field "${action.fieldId}" was not found`);
      }
      const changedElement = executeAction(controls, action);
      highlight(changedElement);
      return { fieldId: action.fieldId, ok: true };
    } catch (error) {
      return {
        fieldId: action.fieldId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
