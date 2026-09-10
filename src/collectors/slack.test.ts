import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripSlackMarkup } from './slack.js';
import { parseManualEntry } from './manual.js';

const at = Date.parse('2026-09-09T17:00:00');

test('slack markup never reaches a client-facing description', () => {
  assert.equal(stripSlackMarkup('helping <@U123> with the deploy'), 'helping with the deploy');
  assert.equal(stripSlackMarkup('paired with <@U1|priya> on auth'), 'paired with priya on auth');
  assert.equal(stripSlackMarkup('see <https://ex.com|the doc>'), 'see the doc');
  assert.equal(stripSlackMarkup('in <#C1|backend> channel'), 'in #backend channel');
  assert.equal(stripSlackMarkup('*bold* _italic_ `code`'), 'bold italic code');
});

test('a real slack message becomes a signal', () => {
  const text = stripSlackMarkup('last one hour I was helping <@U9> with the deploy');
  const signal = parseManualEntry(text, { at });

  assert.ok(signal);
  assert.equal((signal!.end - signal!.start) / 60000, 60);
  assert.equal(signal!.description, 'helping with the deploy');
  assert.equal(signal!.confidence, 'attested');
});

test('a slack message with no duration is skipped, not guessed', () => {
  assert.equal(parseManualEntry(stripSlackMarkup('working on the API today'), { at }), null);
});
