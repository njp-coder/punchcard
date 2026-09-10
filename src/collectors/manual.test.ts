import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseManualEntry } from './manual.js';
import { extractDuration } from '../util/time.js';

const at = Date.parse('2026-09-09T17:00:00');

function parse(text: string) {
  const signal = parseManualEntry(text, { at });
  if (!signal) return null;
  return {
    minutes: Math.round((signal.end - signal.start) / 60000),
    description: signal.description,
    issueKey: signal.hints.issueKey,
  };
}

test('shorthand still works', () => {
  assert.equal(parse('1h sprint review')?.minutes, 60);
  assert.equal(parse('30m standup')?.minutes, 30);
  assert.equal(parse('1h30m client call')?.minutes, 90);
});

test('spoken phrasing that developers actually type in chat', () => {
  // The whole point of the Slack surface: this is what people write.
  assert.equal(parse('last one hour I was helping my junior')?.minutes, 60);
  assert.equal(parse('spent 2 hours on the migration')?.minutes, 120);
  assert.equal(parse('half an hour debugging the payments API')?.minutes, 30);
  assert.equal(parse('an hour and a half in the sprint review')?.minutes, 90);
  assert.equal(parse('a couple of hours pairing with Sam')?.minutes, 120);
  assert.equal(parse('about 45 minutes on the deploy')?.minutes, 45);
  assert.equal(parse('past 2 hours reviewing PRs')?.minutes, 120);
});

test('the description survives with the duration phrase removed', () => {
  assert.equal(parse('last one hour I was helping my junior')?.description, 'helping my junior');
  assert.equal(parse('spent 2 hours on the migration')?.description, 'the migration');
  assert.equal(parse('half an hour debugging the payments api')?.description, 'debugging the payments api');
});

test('issue keys are still picked out of natural sentences', () => {
  assert.equal(parse('45 minutes on PROJ-142 with the auth bug')?.issueKey, 'PROJ-142');
});

test('a sentence with no duration is rejected, not guessed at', () => {
  // "I worked on the API today" says what, never how long. Inventing a number
  // here is exactly the failure this tool exists to avoid.
  assert.equal(parse('I worked on the API today'), null);
  assert.equal(parse('helping a junior'), null);
  assert.equal(parse('a few hours on something'), null);
});

test('two separate durations do not silently merge', () => {
  // "1 hour 30 minutes" is one block; "2 hours ... and 1 hour ..." is not.
  assert.equal(extractDuration('1 hour 30 minutes of review')?.seconds, 90 * 60);
  assert.equal(extractDuration('2 hours on auth then 1 hour on docs')?.seconds, 120 * 60);
});

test('quarter of an hour', () => {
  assert.equal(parse('quarter of an hour triaging')?.minutes, 15);
});
