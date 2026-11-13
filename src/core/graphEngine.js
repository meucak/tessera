/**
 * Knowledge Graph Engine:
 * Builds note/ghost node graph, computes PageRank centrality, connected clusters,
 * BFS shortest path between two notes, orphan diagnostics, and unlinked mentions.
 */

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildKnowledgeGraph(notes, options = {}) {
  const includeGhosts = options.includeGhosts !== false;
  const bySlug = new Map();
  const byId = new Map();

  for (const n of notes) {
    bySlug.set(n.slug, n);
    byId.set(n.id, n);
  }

  const nodesMap = new Map();
  const ghostsMap = new Map();
  const edgeMap = new Map();
  const adjUndirected = new Map();
  const inLinks = new Map();
  const outLinks = new Map();

  for (const n of notes) {
    nodesMap.set(n.id, {
      id: n.id,
      slug: n.slug,
      title: n.title,
      folder: n.folder || 'Inbox',
      tags: Array.isArray(n.tags) ? n.tags : [],
      wordCount: n.wordCount || 0,
      isGhost: false,
      inDegree: 0,
      outDegree: 0,
      degree: 0,
      pagerank: 0,
      clusterId: 0
    });
    adjUndirected.set(n.id, new Set());
    inLinks.set(n.id, new Set());
    outLinks.set(n.id, new Set());
  }

  for (const n of notes) {
    const links = Array.isArray(n.links) ? n.links : [];
    for (const link of links) {
      const targetSlug = link.targetSlug;
      if (!targetSlug || targetSlug === n.slug) continue;
      const target = bySlug.get(targetSlug);

      if (target) {
        const edgeKey = `${n.id}->${target.id}`;
        if (!edgeMap.has(edgeKey)) {
          edgeMap.set(edgeKey, {
            id: edgeKey,
            source: n.id,
            target: target.id,
            isGhost: false
          });
          outLinks.get(n.id).add(target.id);
          inLinks.get(target.id).add(n.id);
          adjUndirected.get(n.id).add(target.id);
          adjUndirected.get(target.id).add(n.id);
        }
      } else if (includeGhosts) {
        const ghostId = `ghost:${targetSlug}`;
        if (!ghostsMap.has(ghostId)) {
          const ghostNode = {
            id: ghostId,
            slug: targetSlug,
            title: link.targetRaw || targetSlug,
            folder: 'Ghost',
            tags: [],
            wordCount: 0,
            isGhost: true,
            inDegree: 0,
            outDegree: 0,
            degree: 0,
            pagerank: 0,
            clusterId: 0,
            referencedBy: []
          };
          ghostsMap.set(ghostId, ghostNode);
          nodesMap.set(ghostId, ghostNode);
          adjUndirected.set(ghostId, new Set());
          inLinks.set(ghostId, new Set());
          outLinks.set(ghostId, new Set());
        }
        const ghostNode = ghostsMap.get(ghostId);
        if (!ghostNode.referencedBy.includes(n.slug)) {
          ghostNode.referencedBy.push(n.slug);
        }
        const edgeKey = `${n.id}->${ghostId}`;
        if (!edgeMap.has(edgeKey)) {
          edgeMap.set(edgeKey, {
            id: edgeKey,
            source: n.id,
            target: ghostId,
            isGhost: true
          });
          outLinks.get(n.id).add(ghostId);
          inLinks.get(ghostId).add(n.id);
          adjUndirected.get(n.id).add(ghostId);
          adjUndirected.get(ghostId).add(n.id);
        }
      }
    }
  }

  const nodes = [...nodesMap.values()];
  const edges = [...edgeMap.values()];

  // Degrees
  for (const node of nodes) {
    node.inDegree = inLinks.get(node.id).size;
    node.outDegree = outLinks.get(node.id).size;
    node.degree = adjUndirected.get(node.id).size;
  }

  // PageRank (30 power iterations, damping 0.85)
  const N = nodes.length;
  if (N > 0) {
    const damping = 0.85;
    let rank = new Map(nodes.map((n) => [n.id, 1 / N]));
    for (let iter = 0; iter < 30; iter++) {
      let sinkMass = 0;
      for (const n of nodes) {
        if (outLinks.get(n.id).size === 0) sinkMass += rank.get(n.id);
      }
      const next = new Map();
      const base = (1 - damping) / N + (damping * sinkMass) / N;
      for (const n of nodes) next.set(n.id, base);

      for (const n of nodes) {
        const outs = outLinks.get(n.id);
        if (outs.size === 0) continue;
        const share = (damping * rank.get(n.id)) / outs.size;
        for (const targetId of outs) {
          next.set(targetId, next.get(targetId) + share);
        }
      }
      rank = next;
    }
    for (const n of nodes) {
      n.pagerank = Number(rank.get(n.id).toFixed(6));
    }
  }

  // Connected component clusters (undirected BFS)
  const visited = new Set();
  const clusters = [];
  let clusterIdx = 0;
  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    clusterIdx++;
    const queue = [node.id];
    visited.add(node.id);
    const members = [];
    while (queue.length > 0) {
      const cur = queue.shift();
      const curNode = nodesMap.get(cur);
      curNode.clusterId = clusterIdx;
      members.push(cur);
      for (const nbr of adjUndirected.get(cur)) {
        if (!visited.has(nbr)) {
          visited.add(nbr);
          queue.push(nbr);
        }
      }
    }
    clusters.push({ id: clusterIdx, size: members.length, memberIds: members });
  }

  const realNodes = nodes.filter((n) => !n.isGhost);
  const orphans = realNodes.filter((n) => n.degree === 0);
  const hubs = [...realNodes].sort((a, b) => b.pagerank - a.pagerank || b.degree - a.degree).slice(0, 5);
  const ghosts = [...ghostsMap.values()].sort((a, b) => b.inDegree - a.inDegree);

  return {
    nodes,
    edges,
    ghosts,
    clusters,
    orphans,
    hubs,
    stats: {
      noteCount: realNodes.length,
      ghostCount: ghosts.length,
      edgeCount: edges.length,
      orphanCount: orphans.length,
      clusterCount: clusters.length
    }
  };
}

/**
 * Shortest undirected semantic chain between two note IDs using BFS.
 */
export function findShortestPath(graph, sourceId, targetId) {
  if (!graph || !sourceId || !targetId) {
    return { found: false, pathIds: [], edgeKeys: [] };
  }
  if (sourceId === targetId) {
    return { found: true, pathIds: [sourceId], edgeKeys: [] };
  }

  const adj = new Map();
  for (const n of graph.nodes) adj.set(n.id, new Set());
  for (const e of graph.edges) {
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
  }
  if (!adj.has(sourceId) || !adj.has(targetId)) {
    return { found: false, pathIds: [], edgeKeys: [] };
  }

  const parent = new Map([[sourceId, null]]);
  const queue = [sourceId];
  let found = false;

  while (queue.length > 0 && !found) {
    const cur = queue.shift();
    for (const nbr of adj.get(cur)) {
      if (parent.has(nbr)) continue;
      parent.set(nbr, cur);
      if (nbr === targetId) {
        found = true;
        break;
      }
      queue.push(nbr);
    }
  }

  if (!found) return { found: false, pathIds: [], edgeKeys: [] };

  const pathIds = [];
  let step = targetId;
  while (step !== null) {
    pathIds.push(step);
    step = parent.get(step);
  }
  pathIds.reverse();

  const edgeKeys = [];
  for (let i = 0; i < pathIds.length - 1; i++) {
    const a = pathIds[i];
    const b = pathIds[i + 1];
    edgeKeys.push(`${a}->${b}`, `${b}->${a}`);
  }

  return { found: true, pathIds, edgeKeys };
}

/**
 * Find other notes that mention `targetNote.title` in plain text without already linking to it.
 */
export function findUnlinkedMentions(targetNote, allNotes) {
  if (!targetNote || !targetNote.title || targetNote.title.length < 3) return [];
  const titleRe = new RegExp(`(?<!\\[\\[)\\b${escapeRegex(targetNote.title)}\\b(?![^\\[]*\\]\\])`, 'gi');
  const results = [];

  for (const other of allNotes) {
    if (other.id === targetNote.id) continue;
    const alreadyLinked = Array.isArray(other.links) && other.links.some((l) => l.targetSlug === targetNote.slug);
    if (alreadyLinked) continue;

    // Strip code blocks & wikilinks before scanning plain prose
    const body = String(other.content || '')
      .replace(/^---[\s\S]*?---\n?/, '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\[\[[^\]]+\]\]/g, ' ');

    const matches = [...body.matchAll(titleRe)];
    if (matches.length > 0) {
      const idx = matches[0].index ?? 0;
      const start = Math.max(0, idx - 45);
      const end = Math.min(body.length, idx + targetNote.title.length + 55);
      const excerpt = (start > 0 ? '…' : '') + body.slice(start, end).replace(/\s+/g, ' ').trim() + (end < body.length ? '…' : '');
      results.push({
        sourceId: other.id,
        sourceSlug: other.slug,
        sourceTitle: other.title,
        targetId: targetNote.id,
        targetTitle: targetNote.title,
        excerpt,
        count: matches.length
      });
    }
  }

  return results;
}
