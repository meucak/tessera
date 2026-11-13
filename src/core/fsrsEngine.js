/**
 * FSRS v4.5 (Free Spaced Repetition Scheduler) implementation.
 * Deterministic scheduling, retrievability decay, interval previews, and forecast curves.
 */

export const Rating = Object.freeze({
  Again: 1,
  Hard: 2,
  Good: 3,
  Easy: 4
});

export const State = Object.freeze({
  New: 0,
  Learning: 1,
  Review: 2,
  Relearning: 3
});

// Default FSRS v4.5 parameter vector (19 weights)
const W = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046,
  1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315,
  2.9898, 0.51655, 0.6621
];

const DECAY = -0.5;
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1; // 19 / 81
const REQUEST_RETENTION = 0.9;
const MAX_INTERVAL_DAYS = 3650;

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function toDate(d) {
  return d instanceof Date ? d : new Date(d);
}

export function createEmptyCard(now = new Date()) {
  const dt = toDate(now);
  return {
    state: State.New,
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    dueAt: dt.toISOString(),
    lastReviewAt: null
  };
}

/**
 * Compute recall probability R(t, S) at `now`.
 */
export function retrievability(card, now = new Date()) {
  if (!card || card.state === State.New || !card.stability || !card.lastReviewAt) {
    return 0;
  }
  const elapsedDays = Math.max(0, (toDate(now).getTime() - toDate(card.lastReviewAt).getTime()) / 86400000);
  if (elapsedDays === 0) return 1;
  return Math.pow(1 + (FACTOR * elapsedDays) / card.stability, DECAY);
}

function initStability(rating) {
  return Math.max(0.1, W[rating - 1]);
}

function initDifficulty(rating) {
  return clamp(W[4] - Math.exp(W[5] * (rating - 1)) + 1, 1, 10);
}

function nextDifficulty(d, rating) {
  const deltaD = -W[6] * (rating - 3);
  const next = d + deltaD * ((10 - d) / 9);
  const meanReverted = W[7] * initDifficulty(Rating.Easy) + (1 - W[7]) * next;
  return clamp(meanReverted, 1, 10);
}

function nextRecallStability(d, s, r, rating) {
  const hardPenalty = rating === Rating.Hard ? W[15] : 1;
  const easyBonus = rating === Rating.Easy ? W[16] : 1;
  const gain = Math.exp(W[8]) *
    (11 - d) *
    Math.pow(s, -W[9]) *
    (Math.exp((1 - r) * W[10]) - 1) *
    hardPenalty *
    easyBonus;
  return Math.max(0.1, s * (1 + gain));
}

function nextForgetStability(d, s, r) {
  const next = W[11] *
    Math.pow(d, -W[12]) *
    (Math.pow(s + 1, W[13]) - 1) *
    Math.exp((1 - r) * W[14]);
  return Math.max(0.1, Math.min(s * 0.9, next));
}

function intervalDaysFromStability(stability) {
  const raw = (stability / FACTOR) * (Math.pow(REQUEST_RETENTION, 1 / DECAY) - 1);
  return clamp(Math.round(raw), 1, MAX_INTERVAL_DAYS);
}

export function formatIntervalLabel(minutes) {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  const months = days / 30;
  if (months < 12) return `${months.toFixed(1).replace(/\.0$/, '')}mo`;
  const years = days / 365;
  return `${years.toFixed(1).replace(/\.0$/, '')}y`;
}

/**
 * Schedule a card given a rating (1=Again, 2=Hard, 3=Good, 4=Easy).
 */
export function scheduleCard(cardInput, rating, now = new Date()) {
  const dt = toDate(now);
  const prev = { ...createEmptyCard(dt), ...cardInput };
  const elapsedDays = prev.lastReviewAt
    ? Math.max(0, (dt.getTime() - toDate(prev.lastReviewAt).getTime()) / 86400000)
    : 0;

  let nextStability = prev.stability;
  let nextDiff = prev.difficulty;
  let nextState = prev.state;
  let lapses = prev.lapses || 0;
  let minutes = 1;
  let intervalDays = 0;

  if (prev.state === State.New) {
    nextStability = initStability(rating);
    nextDiff = initDifficulty(rating);
    if (rating === Rating.Again) {
      nextState = State.Learning;
      minutes = 1;
      intervalDays = 0;
    } else if (rating === Rating.Hard) {
      nextState = State.Learning;
      minutes = 10;
      intervalDays = 0;
    } else if (rating === Rating.Good) {
      nextState = State.Review;
      intervalDays = Math.max(1, intervalDaysFromStability(nextStability));
      minutes = intervalDays * 1440;
    } else {
      nextState = State.Review;
      intervalDays = Math.max(4, intervalDaysFromStability(nextStability));
      minutes = intervalDays * 1440;
    }
  } else {
    const r = retrievability(prev, dt) || 0.9;
    nextDiff = nextDifficulty(prev.difficulty || 5, rating);
    if (rating === Rating.Again) {
      lapses += 1;
      nextStability = nextForgetStability(nextDiff, Math.max(0.2, prev.stability), r);
      nextState = State.Relearning;
      minutes = 5;
      intervalDays = 0;
    } else {
      nextStability = nextRecallStability(nextDiff, Math.max(0.2, prev.stability), r, rating);
      nextState = State.Review;
      let baseDays = intervalDaysFromStability(nextStability);
      if (rating === Rating.Hard) baseDays = Math.max(1, Math.round(baseDays * 0.8));
      if (rating === Rating.Easy) baseDays = Math.max(baseDays + 1, Math.round(baseDays * 1.3));
      intervalDays = clamp(baseDays, 1, MAX_INTERVAL_DAYS);
      minutes = intervalDays * 1440;
    }
  }

  const dueAt = new Date(dt.getTime() + minutes * 60000).toISOString();
  const nextCard = {
    ...prev,
    state: nextState,
    stability: Number(nextStability.toFixed(4)),
    difficulty: Number(nextDiff.toFixed(4)),
    elapsedDays: Number(elapsedDays.toFixed(3)),
    scheduledDays: intervalDays,
    reps: (prev.reps || 0) + 1,
    lapses,
    dueAt,
    lastReviewAt: dt.toISOString()
  };

  return {
    card: nextCard,
    intervalDays,
    minutes,
    label: formatIntervalLabel(minutes),
    log: {
      rating,
      stateBefore: prev.state,
      stability: nextCard.stability,
      difficulty: nextCard.difficulty,
      reviewedAt: dt.toISOString()
    }
  };
}

/**
 * Preview next intervals for all 4 rating buttons.
 */
export function previewIntervals(card, now = new Date()) {
  const out = {};
  for (const r of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]) {
    const res = scheduleCard(card, r, now);
    out[r] = {
      rating: r,
      label: res.label,
      days: res.intervalDays,
      minutes: res.minutes,
      card: res.card
    };
  }
  return out;
}

/**
 * Build a multi-day review workload & average retrievability forecast curve.
 */
export function buildRetentionForecast(cards, days = 30, now = new Date()) {
  const base = toDate(now);
  const startDay = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());
  const series = [];

  for (let d = 0; d < days; d++) {
    const dayStart = startDay + d * 86400000;
    const dayEnd = dayStart + 86400000;
    const probeDate = new Date(dayStart + 43200000);
    let dueCount = 0;
    let rSum = 0;
    let rCount = 0;

    for (const card of cards) {
      const dueMs = toDate(card.dueAt || base).getTime();
      if (d === 0 ? dueMs <= dayEnd : (dueMs > dayStart && dueMs <= dayEnd)) {
        dueCount++;
      }
      if (card.state !== State.New && card.stability > 0 && card.lastReviewAt) {
        rSum += retrievability(card, probeDate);
        rCount++;
      }
    }

    series.push({
      day: d,
      date: new Date(dayStart).toISOString().slice(0, 10),
      dueCount,
      avgRetrievability: rCount > 0 ? Number((rSum / rCount).toFixed(3)) : 1
    });
  }

  return series;
}
