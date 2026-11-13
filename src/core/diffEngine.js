/**
 * Myers line diff & intra-line token diff engine.
 */

function splitLinesPreservingEmpty(text) {
  if (!text) return [];
  return String(text).replace(/\r\n/g, '\n').split('\n');
}

function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  // Use Myers O((N+M)D) for reasonable line counts, falling back to bounded DP
  const maxD = n + m;
  if (maxD === 0) return [];

  const offset = maxD;
  const v = new Int32Array(2 * maxD + 2);
  const trace = [];

  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return backtrackMyers(a, b, trace, offset);
      }
    }
  }
  return [];
}

function backtrackMyers(a, b, trace, offset) {
  let x = a.length;
  let y = b.length;
  const ops = [];

  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ type: 'equal', text: a[x], oldLine: x + 1, newLine: y + 1 });
    }
    if (d > 0) {
      if (x === prevX) {
        y--;
        ops.push({ type: 'add', text: b[y], oldLine: null, newLine: y + 1 });
      } else {
        x--;
        ops.push({ type: 'delete', text: a[x], oldLine: x + 1, newLine: null });
      }
    }
  }

  ops.reverse();
  return ops;
}

/**
 * Compute structured line diff hunks and summary counters.
 */
export function computeLineDiff(oldText, newText) {
  const a = splitLinesPreservingEmpty(oldText);
  const b = splitLinesPreservingEmpty(newText);
  const hunks = lcsDiff(a, b);
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const h of hunks) {
    if (h.type === 'add') added++;
    else if (h.type === 'delete') removed++;
    else unchanged++;
  }
  return {
    hunks,
    stats: { added, removed, unchanged }
  };
}

/**
 * Compute word/whitespace-level diff between two lines for inline diff highlights.
 */
export function computeWordDiff(oldLine, newLine) {
  const tokenize = (s) => String(s ?? '').match(/\S+|\s+/g) || [];
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  const ops = lcsDiff(a, b);
  const merged = [];
  for (const op of ops) {
    const type = op.type === 'equal' ? 'eq' : op.type === 'add' ? 'add' : 'del';
    const prev = merged[merged.length - 1];
    if (prev && prev.type === type) {
      prev.text += op.text;
    } else {
      merged.push({ type, text: op.text });
    }
  }
  return merged;
}
