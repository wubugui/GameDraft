import { describe, expect, it } from 'vitest';
import { RulesPanelUI } from './RulesPanelUI';

const summary = (RulesPanelUI.prototype as unknown as {
  aggregateVerified(layers: {text: string; verified?: string}[], requireAll?: boolean): string;
}).aggregateVerified;

describe('rulebook narrative verification summary', () => {
  it('an observed appearance must not validate an untested explanation', () => {
    const layers = [{text: 'Observed', verified: 'effective'}, {text: 'Hypothesis', verified: 'unverified'}];
    expect(summary(layers, true)).toBe('unverified');
    expect(summary(layers, false)).toBe('effective'); // Unmigrated rules retain their existing display contract.
  });
  it('doubt takes priority; wholly tested current knowledge can display effective', () => {
    expect(summary([{text:'Observed', verified:'effective'}, {text:'Qualified', verified:'questionable'}], true)).toBe('questionable');
    expect(summary([{text:'Observed', verified:'effective'}, {text:'Tested', verified:'effective'}], true)).toBe('effective');
    expect(summary([], true)).toBe('unverified');
  });
});
