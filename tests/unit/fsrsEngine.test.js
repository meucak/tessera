import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Rating,
  State,
  createEmptyCard,
  scheduleCard,
  previewIntervals,
  retrievability,
  buildRetentionForecast
} from '../../src/core/fsrsEngine.js';

test('createEmptyCard initializes a New card with zero reps and finite defaults', () => {
  const now = new Date('2026-11-14T00:00:00Z');
  const card = createEmptyCard(now);
  assert.equal(card.state, State.New);
  assert.equal(card.reps, 0);
  assert.equal(card.lapses, 0);
  assert.equal(card.stability, 0);
  assert.equal(card.dueAt, now.toISOString());
});

test('previewIntervals produces monotonic intervals Again < Hard <= Good < Easy', () => {
  const now = new Date('2026-11-14T00:00:00Z');
  const card = createEmptyCard(now);
  const preview = previewIntervals(card, now);

  assert.ok(preview[Rating.Again].minutes < preview[Rating.Hard].minutes);
  assert.ok(preview[Rating.Hard].minutes <= preview[Rating.Good].minutes);
  assert.ok(preview[Rating.Good].minutes < preview[Rating.Easy].minutes);
  assert.match(preview[Rating.Again].label, /m|min|now/i);
});

test('scheduleCard transitions New -> Review on Good/Easy and increases stability on subsequent reviews', () => {
  const day0 = new Date('2026-11-14T00:00:00Z');
  const c0 = createEmptyCard(day0);
  const r1 = scheduleCard(c0, Rating.Good, day0);

  assert.equal(r1.card.reps, 1);
  assert.equal(r1.card.state, State.Review);
  assert.ok(r1.card.stability > 0);

  const dayLater = new Date(day0.getTime() + r1.intervalDays * 86400000);
  const r2 = scheduleCard(r1.card, Rating.Good, dayLater);
  assert.equal(r2.card.reps, 2);
  assert.ok(r2.card.stability > r1.card.stability);
  assert.ok(r2.intervalDays > r1.intervalDays);
});

test('scheduleCard handles lapse with Rating.Again by moving Review -> Relearning and incrementing lapses', () => {
  const day0 = new Date('2026-11-14T00:00:00Z');
  const r1 = scheduleCard(createEmptyCard(day0), Rating.Easy, day0);
  const day5 = new Date(day0.getTime() + 5 * 86400000);
  const lapsed = scheduleCard(r1.card, Rating.Again, day5);

  assert.equal(lapsed.card.state, State.Relearning);
  assert.equal(lapsed.card.lapses, 1);
  assert.ok(lapsed.card.stability < r1.card.stability);
});

test('retrievability decays strictly over elapsed days and equals 1.0 at t=0', () => {
  const day0 = new Date('2026-11-14T00:00:00Z');
  const { card } = scheduleCard(createEmptyCard(day0), Rating.Good, day0);
  const r0 = retrievability(card, day0);
  const r10 = retrievability(card, new Date(day0.getTime() + 10 * 86400000));
  const r60 = retrievability(card, new Date(day0.getTime() + 60 * 86400000));

  assert.equal(r0, 1);
  assert.ok(r10 < 1 && r10 > r60);
  assert.ok(r60 > 0);
});

test('buildRetentionForecast returns exact horizon length with valid due counts', () => {
  const now = new Date('2026-11-14T00:00:00Z');
  const c1 = scheduleCard(createEmptyCard(now), Rating.Good, now).card;
  const c2 = createEmptyCard(now);
  const forecast = buildRetentionForecast([c1, c2], 14, now);

  assert.equal(forecast.length, 14);
  assert.ok(forecast[0].dueCount >= 1);
  assert.ok(forecast[0].avgRetrievability >= 0 && forecast[0].avgRetrievability <= 1);
});
