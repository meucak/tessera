/**
 * HTTP REST API client with client-id tagging for WebSocket echo avoidance.
 */

export const CLIENT_ID = typeof crypto !== 'undefined' && crypto.randomUUID
  ? crypto.randomUUID()
  : `client-${Math.random().toString(36).slice(2)}`;

async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': CLIENT_ID,
      ...(options.headers || {})
    },
    ...options
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const errBody = await res.json();
      if (errBody.error) msg = errBody.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res;
}

export const api = {
  health: () => request('/api/health'),
  listNotes: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.folder) qs.set('folder', params.folder);
    if (params.tag) qs.set('tag', params.tag);
    if (params.filter) qs.set('filter', params.filter);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request(`/api/notes${suffix}`);
  },
  getNote: (idOrSlug) => request(`/api/notes/${encodeURIComponent(idOrSlug)}`),
  createNote: (data) => request('/api/notes', { method: 'POST', body: JSON.stringify(data) }),
  updateNote: (id, data) => request(`/api/notes/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteNote: (id) => request(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  openDailyNote: (date = null) => request('/api/notes/daily', { method: 'POST', body: JSON.stringify({ date }) }),
  linkMention: (targetId, sourceId) =>
    request(`/api/notes/${encodeURIComponent(targetId)}/link-mention`, {
      method: 'POST',
      body: JSON.stringify({ sourceId })
    }),
  getVersions: (id) => request(`/api/notes/${encodeURIComponent(id)}/versions`),
  getDiff: (id, from, to = 'current') =>
    request(`/api/notes/${encodeURIComponent(id)}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  restoreVersion: (id, versionId) =>
    request(`/api/notes/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      body: JSON.stringify({ versionId })
    }),
  getGraph: (includeGhosts = true) => request(`/api/graph?includeGhosts=${includeGhosts}`),
  getGraphPath: (source, target) =>
    request(`/api/graph/path?source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`),
  listTasks: () => request('/api/tasks'),
  toggleTask: (noteId, lineNo, done) =>
    request('/api/tasks/toggle', { method: 'POST', body: JSON.stringify({ noteId, lineNo, done }) }),
  listFlashcards: () => request('/api/flashcards'),
  reviewFlashcard: (id, rating) =>
    request(`/api/flashcards/${encodeURIComponent(id)}/review`, { method: 'POST', body: JSON.stringify({ rating }) }),
  listBoards: () => request('/api/boards'),
  createBoard: (data) => request('/api/boards', { method: 'POST', body: JSON.stringify(data) }),
  saveBoard: (id, data) => request(`/api/boards/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteBoard: (id) => request(`/api/boards/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  importVault: (payload) => request('/api/vault/import', { method: 'POST', body: JSON.stringify(payload) })
};
