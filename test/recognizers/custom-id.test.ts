import { describe, it, expect } from 'vitest';
import { createCaseIdRecognizer } from '../../src/recognizers/custom-id.js';
import { anonymizeRegexOnly } from '../../src/index.js';
import { PIIType } from '../../src/types/index.js';

describe('Case ID Recognizer', () => {
  const recognizer = createCaseIdRecognizer();
  const texts = (text: string): string[] => recognizer.find(text).map((m) => m.text);

  it('should detect a single-segment case number', () => {
    expect(texts('See CASE-12345 for details')).toEqual(['CASE-12345']);
  });

  it('should include every hyphenated segment of a case number', () => {
    expect(texts('Reference: CASE-2024-001')).toEqual(['CASE-2024-001']);
    expect(texts('Related: CASE-2024-789012, CASE-2023-456789')).toEqual([
      'CASE-2024-789012',
      'CASE-2023-456789',
    ]);
  });

  it('should include slash-separated segments', () => {
    expect(texts('Our ref REF-2024/00123.')).toContain('REF-2024/00123');
  });

  it('should not match words that merely start with a keyword', () => {
    const prose =
      'Refactor the reference code, refresh the filesystem and write a case-study for ticket-system.';
    expect(texts(prose)).toEqual([]);
  });

  it('should not absorb trailing words without digits', () => {
    expect(texts('ticket-1234-related issue')).toEqual(['ticket-1234']);
  });

  it('should leave no fragment behind after anonymization', async () => {
    const result = await anonymizeRegexOnly(
      'Case CASE-2024-001 is closed, see REF-2024/00123.',
      {
        enabledTypes: new Set([PIIType.CASE_ID]),
        regexEnabledTypes: new Set([PIIType.CASE_ID]),
      }
    );

    expect(result.anonymizedText).toBe(
      'Case <PII type="CASE_ID" id="1"/> is closed, see <PII type="CASE_ID" id="2"/>.'
    );
  });
});
