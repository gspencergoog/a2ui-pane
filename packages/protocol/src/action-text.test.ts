import { describe, it, expect } from 'vitest';
import { formatActionText, parseActionText, A2uiActionDetails } from './action-text.js';

describe('formatActionText and parseActionText', () => {
  const sampleAction: A2uiActionDetails = {
    name: 'submitForm',
    surfaceId: 'survey-surface',
    sourceComponentId: 'btn-submit',
    context: {
      rating: 5,
    },
  };

  it('formats action text with label and summary', () => {
    const text = formatActionText(sampleAction, { label: 'Submit Feedback' });
    expect(text).toContain(
      '[A2UI] Triggered "Submit Feedback" (submitForm) on surface survey-surface.',
    );
    expect(text).toContain('<a2ui-action>');
    expect(text).toContain('</a2ui-action>');

    const parsed = parseActionText(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe('v0.9');
    expect(parsed?.action.name).toBe('submitForm');
    expect(parsed?.action.surfaceId).toBe('survey-surface');
    expect(parsed?.action.context).toEqual({ rating: 5 });
    expect(parsed?.dataModel).toBeUndefined();
  });

  it('formats action text without label', () => {
    const text = formatActionText(sampleAction);
    expect(text).toContain('[A2UI] Triggered (submitForm) on surface survey-surface.');
  });

  it('includes dataModel when provided', () => {
    const dataModel = { username: 'testuser', score: 100 };
    const text = formatActionText(sampleAction, { dataModel });

    const parsed = parseActionText(text);
    expect(parsed?.dataModel).toEqual(dataModel);
  });

  it('returns null on invalid or missing action tags', () => {
    expect(parseActionText('')).toBeNull();
    expect(parseActionText('hello world')).toBeNull();
    expect(parseActionText('<a2ui-action>not-json</a2ui-action>')).toBeNull();
    expect(parseActionText('<a2ui-action>{}</a2ui-action>')).toBeNull();
  });
});
