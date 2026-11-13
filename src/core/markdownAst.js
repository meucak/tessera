const TURKISH_MAP = {
  'ç': 'c', 'Ç': 'c',
  'ğ': 'g', 'Ğ': 'g',
  'ı': 'i', 'İ': 'i',
  'ö': 'o', 'Ö': 'o',
  'ş': 's', 'Ş': 's',
  'ü': 'u', 'Ü': 'u'
};

const HEX_COLOR_RE = /^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const CALLOUT_LABELS = {
  NOTE: 'Note',
  TIP: 'Tip',
  IMPORTANT: 'Important',
  WARNING: 'Warning',
  CAUTION: 'Caution'
};

const CODE_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'async', 'await', 'import', 'from',
  'export', 'default', 'if', 'else', 'for', 'while', 'switch', 'case', 'break',
  'try', 'catch', 'finally', 'throw', 'new', 'class', 'extends', 'true', 'false',
  'null', 'undefined', 'def', 'elif', 'lambda', 'yield', 'with', 'as', 'in', 'not',
  'and', 'or', 'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE',
  'SET', 'DELETE', 'CREATE', 'TABLE', 'VIRTUAL', 'USING', 'JOIN', 'ON', 'ORDER',
  'BY', 'LIMIT', 'GROUP', 'MATCH', 'PRAGMA', 'BEGIN', 'COMMIT', 'ROLLBACK'
]);

/**
 * Normalize text (including Turkish glyphs) into a stable URL-safe slug.
 */
export function slugify(text) {
  if (!text) return '';
  let out = String(text).replace(/[çÇğĞıİöÖşŞüÜ]/g, (ch) => TURKISH_MAP[ch] || ch);
  out = out.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return out
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/**
 * Deterministic 16-char hex digest (dual-seed FNV-1a) safe for browser & Node.
 */
export function hashString(input) {
  const str = String(input || '');
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (c + i) & 0xff;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeUrl(raw) {
  const cleaned = String(raw ?? '').trim().replace(/[\u0000-\u001F\u007F]/g, '');
  if (!cleaned) return '#';
  if (cleaned.startsWith('#') || cleaned.startsWith('/') || cleaned.startsWith('./') || cleaned.startsWith('../')) {
    return cleaned;
  }
  const colonIdx = cleaned.indexOf(':');
  if (colonIdx === -1) return cleaned;
  const proto = cleaned.slice(0, colonIdx + 1).toLowerCase();
  if (proto === 'http:' || proto === 'https:' || proto === 'mailto:') {
    return cleaned;
  }
  return '#blocked';
}

function parseYamlValue(val) {
  const trimmed = val.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  return trimmed.replace(/^["']|["']$/g, '');
}

/**
 * Parse leading YAML frontmatter block if present.
 */
export function parseFrontmatter(content) {
  const normalized = String(content ?? '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, bodyLines: lines, bodyStartLine: 1 };
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return { frontmatter: {}, bodyLines: lines, bodyStartLine: 1 };
  }

  const frontmatter = {};
  let activeArrayKey = null;
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && activeArrayKey) {
      if (!Array.isArray(frontmatter[activeArrayKey])) frontmatter[activeArrayKey] = [];
      frontmatter[activeArrayKey].push(listMatch[1].trim().replace(/^["']|["']$/g, ''));
      continue;
    }
    const kvMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      const rawVal = kvMatch[2].trim();
      if (!rawVal) {
        frontmatter[key] = [];
        activeArrayKey = key;
      } else {
        frontmatter[key] = parseYamlValue(rawVal);
        activeArrayKey = null;
      }
    }
  }

  return {
    frontmatter,
    bodyLines: lines.slice(endIdx + 1),
    bodyStartLine: endIdx + 2
  };
}

function highlightCode(code, lang) {
  const escaped = escapeHtml(code);
  const lower = (lang || '').toLowerCase();
  if (!lower || lower === 'text' || lower === 'plain') {
    return escaped;
  }
  // Tokenize line by line safely on already-escaped HTML
  return escaped
    .split('\n')
    .map((line) => {
      // Single-line comments (# or // or --)
      const commentMatch = line.match(/^(\s*(?:\/\/|#|--).*)$/);
      if (commentMatch) {
        return `<span class="tok-comment">${line}</span>`;
      }
      return line.replace(
        /(&quot;.*?&quot;|&#39;.*?&#39;|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g,
        (tok) => {
          if (tok.startsWith('&quot;') || tok.startsWith('&#39;')) {
            return `<span class="tok-string">${tok}</span>`;
          }
          if (/^\d/.test(tok)) {
            return `<span class="tok-number">${tok}</span>`;
          }
          if (CODE_KEYWORDS.has(tok) || CODE_KEYWORDS.has(tok.toUpperCase())) {
            return `<span class="tok-keyword">${tok}</span>`;
          }
          return tok;
        }
      );
    })
    .join('\n');
}

function addTagUnique(tagSet, tag) {
  const clean = String(tag || '').trim().replace(/^#/, '');
  if (!clean || HEX_COLOR_RE.test(clean)) return;
  tagSet.add(clean);
}

function renderInline(text, ctx) {
  // Extract inline code spans and inline math first so internal syntax stays literal
  const placeholders = [];
  const stash = (html) => {
    const idx = placeholders.length;
    placeholders.push(html);
    return `\u0000PH${idx}\u0000`;
  };

  let work = String(text ?? '');

  // Inline code: `...`
  work = work.replace(/`([^`]+)`/g, (_, code) => {
    return stash(`<code>${escapeHtml(code)}</code>`);
  });

  // Inline math: $...$
  work = work.replace(/\$([^$\n]+?)\$/g, (_, math) => {
    return stash(`<span class="math-inline">${escapeHtml(math)}</span>`);
  });

  // Embedded inline note transclusion marker before HTML escaping
  work = work.replace(/!\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g, (_, targetRaw, alias) => {
    const slug = slugify(targetRaw);
    ctx.embeds.set(slug, { targetRaw: targetRaw.trim(), targetSlug: slug });
    const label = alias ? alias.trim() : targetRaw.trim();
    return stash(renderEmbedBlock(slug, label, ctx));
  });

  // Wikilinks: [[Target|Alias]] or [[Target]] before HTML escaping so '&' etc. keep real slugs
  work = work.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, targetRaw, alias) => {
    const cleanTarget = targetRaw.trim();
    const targetSlug = slugify(cleanTarget);
    const label = (alias || cleanTarget).trim();
    if (!ctx.links.has(targetSlug)) {
      ctx.links.set(targetSlug, { targetRaw: cleanTarget, targetSlug, alias: alias ? alias.trim() : null });
    }
    const resolved = ctx.resolveNote ? ctx.resolveNote(targetSlug) : null;
    const cls = resolved ? 'wikilink is-resolved' : 'wikilink is-ghost';
    return stash(`<a href="#note/${escapeHtml(targetSlug)}" class="${cls}" data-wikilink-slug="${escapeHtml(targetSlug)}">${escapeHtml(label)}</a>`);
  });

  // Markdown images: ![alt](url) supporting 1 level of balanced parens
  work = work.replace(/!\[([^\]]*)\]\(([^()\s]+(?:\([^)]*\)[^()\s]*)*)\)/g, (_, alt, url) => {
    const safe = sanitizeUrl(url);
    return stash(`<img src="${escapeHtml(safe)}" alt="${escapeHtml(alt)}" loading="lazy">`);
  });

  // Markdown links: [label](url) supporting 1 level of balanced parens
  work = work.replace(/\[([^\]]+)\]\(([^()\s]+(?:\([^)]*\)[^()\s]*)*)\)/g, (_, label, url) => {
    const safe = sanitizeUrl(url);
    const external = safe.startsWith('http://') || safe.startsWith('https://');
    const extra = external ? ' target="_blank" rel="noopener noreferrer"' : '';
    return stash(`<a href="${escapeHtml(safe)}"${extra}>${escapeHtml(label)}</a>`);
  });

  // Escape all remaining raw HTML before applying safe markdown text formatting
  work = escapeHtml(work);

  // Cloze deletion highlight: {{answer}}
  work = work.replace(/\{\{([^}]+)\}\}/g, (_, inner) => {
    return `<mark class="cloze-chip">${inner}</mark>`;
  });

  // Formatting: bold+italic, bold, italic, strikethrough
  work = work
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Tags: #topic or #topic/subtopic (never hex colors like #ffffff)
  work = work.replace(/(^|[\s(])#([A-Za-zçğıöşüÇĞİÖŞÜ][A-Za-z0-9çğıöşüÇĞİÖŞÜ_/-]*)/g, (full, pre, tag) => {
    if (HEX_COLOR_RE.test(tag)) return full;
    addTagUnique(ctx.tags, tag);
    return `${pre}<button type="button" class="inline-tag" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>`;
  });

  // Restore stashed HTML tokens
  work = work.replace(/\u0000PH(\d+)\u0000/g, (_, idx) => placeholders[Number(idx)] ?? '');
  return work;
}

function renderEmbedBlock(slug, label, ctx) {
  if (ctx.embedStack.has(slug)) {
    return `<aside class="tessera-embed is-cycle"><strong>Embed: ${escapeHtml(label)}</strong><p class="embed-meta">Circular transclusion detected (${escapeHtml(slug)}).</p></aside>`;
  }
  if (ctx.embedDepth >= ctx.maxEmbedDepth) {
    return `<aside class="tessera-embed is-limit"><strong>Embed: ${escapeHtml(label)}</strong><p class="embed-meta">Embed depth limit reached.</p></aside>`;
  }
  const target = ctx.resolveNote ? ctx.resolveNote(slug) : null;
  if (!target) {
    return `<aside class="tessera-embed is-missing"><strong>Missing note: ${escapeHtml(label)}</strong><p><button type="button" class="btn-ghost-create" data-create-ghost="${escapeHtml(slug)}">Create [[${escapeHtml(label)}]]</button></p></aside>`;
  }
  const nextStack = new Set(ctx.embedStack);
  nextStack.add(slug);
  const parsedChild = parseMarkdown(target.content || '', {
    resolveNote: ctx.resolveNote,
    maxEmbedDepth: ctx.maxEmbedDepth,
    _embedDepth: ctx.embedDepth + 1,
    _embedStack: nextStack
  });
  return `<aside class="tessera-embed"><div class="embed-header"><a href="#note/${escapeHtml(target.slug)}" class="wikilink is-resolved" data-wikilink-slug="${escapeHtml(target.slug)}">${escapeHtml(target.title || label)}</a></div><div class="embed-body">${parsedChild.html}</div></aside>`;
}

function parseTaskMetadata(text) {
  let priority = 'normal';
  if (/!high\b/i.test(text)) priority = 'high';
  else if (/!medium\b/i.test(text)) priority = 'medium';
  else if (/!low\b/i.test(text)) priority = 'low';

  const dueMatch = text.match(/@(\d{4}-\d{2}-\d{2})/);
  const doing = /#doing\b/i.test(text);
  return {
    priority,
    dueDate: dueMatch ? dueMatch[1] : null,
    doing
  };
}

function addClozeFlashcardsFromLine(line, lineNo, flashcards, seenHashes) {
  const matches = [...line.matchAll(/\{\{([^}]+)\}\}/g)];
  if (matches.length === 0) return;
  const front = line.replace(/\{\{([^}]+)\}\}/g, '[...]').trim();
  const back = matches.map((m) => m[1].trim()).join(' · ');
  const key = `cloze::${line.trim()}`;
  const blockHash = hashString(key);
  if (!seenHashes.has(blockHash)) {
    seenHashes.add(blockHash);
    flashcards.push({ blockHash, kind: 'cloze', front, back, lineNo });
  }
}

function splitTableRow(row) {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableSeparator(line) {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}

/**
 * Parse a Markdown + Wikilink document into AST metadata + sanitized HTML.
 */
export function parseMarkdown(content, options = {}) {
  const { frontmatter, bodyLines, bodyStartLine } = parseFrontmatter(content);
  const ctx = {
    resolveNote: options.resolveNote || null,
    maxEmbedDepth: options.maxEmbedDepth ?? 2,
    embedDepth: options._embedDepth ?? 0,
    embedStack: options._embedStack ? new Set(options._embedStack) : new Set(),
    tags: new Set(),
    links: new Map(),
    embeds: new Map()
  };

  if (Array.isArray(frontmatter.tags)) {
    for (const t of frontmatter.tags) addTagUnique(ctx.tags, t);
  } else if (typeof frontmatter.tags === 'string') {
    for (const t of frontmatter.tags.split(',')) addTagUnique(ctx.tags, t);
  }

  const headings = [];
  const slugCount = new Map();
  const tasks = [];
  const flashcards = [];
  const seenCardHashes = new Set();
  const htmlBlocks = [];
  let firstH1 = null;
  let wordCount = 0;

  let i = 0;
  while (i < bodyLines.length) {
    const line = bodyLines[i];
    const lineNo = bodyStartLine + i;
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Fenced code block
    const fenceMatch = trimmed.match(/^(```+|~~~+)\s*([A-Za-z0-9_+-]*)/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = fenceMatch[2] || 'text';
      const codeLines = [];
      i++;
      while (i < bodyLines.length && !bodyLines[i].trim().startsWith(fence)) {
        codeLines.push(bodyLines[i]);
        i++;
      }
      if (i < bodyLines.length) i++;
      const rawCode = codeLines.join('\n');
      wordCount += rawCode.trim() ? rawCode.trim().split(/\s+/).length : 0;
      htmlBlocks.push(
        `<div class="code-block" data-lang="${escapeHtml(lang)}"><div class="code-header"><span class="code-lang">${escapeHtml(lang)}</span><button type="button" class="btn-copy-code" data-copy-code>Copy</button></div><pre tabindex="0"><code>${highlightCode(rawCode, lang)}</code></pre></div>`
      );
      continue;
    }

    // Block math $$ ... $$
    if (trimmed.startsWith('$$')) {
      const mathLines = [];
      if (trimmed.length > 2 && trimmed.endsWith('$$')) {
        mathLines.push(trimmed.slice(2, -2).trim());
        i++;
      } else {
        i++;
        while (i < bodyLines.length && !bodyLines[i].trim().startsWith('$$')) {
          mathLines.push(bodyLines[i]);
          i++;
        }
        if (i < bodyLines.length) i++;
      }
      htmlBlocks.push(`<div class="math-block">${escapeHtml(mathLines.join('\n'))}</div>`);
      continue;
    }

    // Horizontal rule
    if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) {
      htmlBlocks.push('<hr>');
      i++;
      continue;
    }

    // Heading (# through ######)
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const rawHeading = headingMatch[2].trim();
      if (level === 1 && !firstH1) firstH1 = rawHeading;
      let baseSlug = slugify(rawHeading) || `section-${lineNo}`;
      const count = slugCount.get(baseSlug) || 0;
      slugCount.set(baseSlug, count + 1);
      const id = count === 0 ? baseSlug : `${baseSlug}-${count + 1}`;
      headings.push({ level, text: rawHeading, id, lineNo });
      wordCount += rawHeading.split(/\s+/).length;
      htmlBlocks.push(`<h${level} id="${escapeHtml(id)}">${renderInline(rawHeading, ctx)}</h${level}>`);
      i++;
      continue;
    }

    // Standalone embed ![[Target]]
    const embedMatch = trimmed.match(/^!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
    if (embedMatch) {
      const targetRaw = embedMatch[1].trim();
      const targetSlug = slugify(targetRaw);
      const label = (embedMatch[2] || targetRaw).trim();
      ctx.embeds.set(targetSlug, { targetRaw, targetSlug });
      htmlBlocks.push(renderEmbedBlock(targetSlug, label, ctx));
      i++;
      continue;
    }

    // Multi-line flashcard: Front \n ?? \n Back
    if (i + 2 < bodyLines.length && bodyLines[i + 1].trim() === '??') {
      const frontLines = [line.trim()];
      let j = i + 2;
      const backLines = [];
      while (j < bodyLines.length && bodyLines[j].trim() !== '' && !bodyLines[j].trim().startsWith('#')) {
        backLines.push(bodyLines[j].trim());
        j++;
      }
      if (backLines.length > 0) {
        const front = frontLines.join(' ');
        const back = backLines.join('\n');
        const blockHash = hashString(`qa::${front}::${back}`);
        if (!seenCardHashes.has(blockHash)) {
          seenCardHashes.add(blockHash);
          flashcards.push({ blockHash, kind: 'qa', front, back, lineNo });
        }
        htmlBlocks.push(
          `<div class="flashcard-inline"><div class="fc-badge">Flashcard</div><div class="fc-front">${renderInline(front, ctx)}</div><div class="fc-back">${renderInline(back, ctx)}</div></div>`
        );
        wordCount += (front + ' ' + back).split(/\s+/).length;
        i = j;
        continue;
      }
    }

    // Single-line Q::A flashcard
    const qaMatch = line.match(/^(.+?)\s*::\s*(.+)$/);
    if (qaMatch && !trimmed.startsWith('|') && !trimmed.startsWith('>')) {
      const front = qaMatch[1].trim();
      const back = qaMatch[2].trim();
      const blockHash = hashString(`qa::${front}::${back}`);
      if (!seenCardHashes.has(blockHash)) {
        seenCardHashes.add(blockHash);
        flashcards.push({ blockHash, kind: 'qa', front, back, lineNo });
      }
      htmlBlocks.push(
        `<div class="flashcard-inline"><div class="fc-badge">Flashcard</div><div class="fc-front">${renderInline(front, ctx)}</div><div class="fc-back">${renderInline(back, ctx)}</div></div>`
      );
      wordCount += (front + ' ' + back).split(/\s+/).length;
      i++;
      continue;
    }

    // Callout / Blockquote
    if (trimmed.startsWith('>')) {
      const quoteLines = [];
      while (i < bodyLines.length && bodyLines[i].trim().startsWith('>')) {
        quoteLines.push(bodyLines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const calloutMatch = quoteLines[0]?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
      if (calloutMatch) {
        const type = calloutMatch[1].toUpperCase();
        const title = calloutMatch[2].trim() || CALLOUT_LABELS[type];
        const innerMd = quoteLines.slice(1).join('\n');
        const innerParsed = parseMarkdown(innerMd, {
          resolveNote: ctx.resolveNote,
          maxEmbedDepth: ctx.maxEmbedDepth,
          _embedDepth: ctx.embedDepth,
          _embedStack: ctx.embedStack
        });
        for (const t of innerParsed.tags) ctx.tags.add(t);
        for (const l of innerParsed.links) ctx.links.set(l.targetSlug, l);
        wordCount += innerParsed.wordCount;
        htmlBlocks.push(
          `<div class="callout callout-${type.toLowerCase()}"><div class="callout-title">${escapeHtml(title)}</div><div class="callout-body">${innerParsed.html}</div></div>`
        );
      } else {
        const inner = quoteLines.map((q) => renderInline(q, ctx)).join('<br>');
        wordCount += quoteLines.join(' ').trim().split(/\s+/).filter(Boolean).length;
        htmlBlocks.push(`<blockquote>${inner}</blockquote>`);
      }
      continue;
    }

    // GFM Table
    if (trimmed.includes('|') && i + 1 < bodyLines.length && isTableSeparator(bodyLines[i + 1])) {
      const headers = splitTableRow(line);
      const alignments = splitTableRow(bodyLines[i + 1]).map((sep) => {
        if (sep.startsWith(':') && sep.endsWith(':')) return 'center';
        if (sep.endsWith(':')) return 'right';
        if (sep.startsWith(':')) return 'left';
        return '';
      });
      i += 2;
      const rows = [];
      while (i < bodyLines.length && bodyLines[i].trim().includes('|') && bodyLines[i].trim() !== '') {
        rows.push(splitTableRow(bodyLines[i]));
        i++;
      }
      const thead = headers
        .map((h, idx) => {
          const align = alignments[idx] ? ` style="text-align:${alignments[idx]}"` : '';
          wordCount += h.split(/\s+/).filter(Boolean).length;
          return `<th${align}>${renderInline(h, ctx)}</th>`;
        })
        .join('');
      const tbody = rows
        .map((r) => {
          const cells = headers
            .map((_, idx) => {
              const cell = r[idx] ?? '';
              const align = alignments[idx] ? ` style="text-align:${alignments[idx]}"` : '';
              wordCount += cell.split(/\s+/).filter(Boolean).length;
              return `<td${align}>${renderInline(cell, ctx)}</td>`;
            })
            .join('');
          return `<tr>${cells}</tr>`;
        })
        .join('');
      htmlBlocks.push(`<div class="table-wrap"><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`);
      continue;
    }

    // Lists (unordered / ordered / tasks)
    const listStartMatch = line.match(/^(\s*)(?:([-*+])|(\d+)\.)\s+(.*)$/);
    if (listStartMatch) {
      const isOrdered = Boolean(listStartMatch[3]);
      const tag = isOrdered ? 'ol' : 'ul';
      const itemsHtml = [];
      let hasTasks = false;
      while (i < bodyLines.length) {
        const curLine = bodyLines[i];
        const curLineNo = bodyStartLine + i;
        const m = curLine.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/);
        if (!m) break;
        const indent = Math.floor(m[1].length / 2);
        const rawItem = m[2];
        const taskMatch = rawItem.match(/^\[([ xX])\]\s*(.*)$/);
        if (taskMatch) {
          hasTasks = true;
          const done = taskMatch[1].toLowerCase() === 'x';
          const taskText = taskMatch[2].trim();
          const meta = parseTaskMetadata(taskText);
          tasks.push({
            lineNo: curLineNo,
            text: taskText,
            done,
            doing: meta.doing,
            priority: meta.priority,
            dueDate: meta.dueDate
          });
          addClozeFlashcardsFromLine(taskText, curLineNo, flashcards, seenCardHashes);
          wordCount += taskText.split(/\s+/).filter(Boolean).length;
          itemsHtml.push(
            `<li class="task-item${done ? ' is-done' : ''}" style="--indent:${indent}"><label><input type="checkbox" data-task-line="${curLineNo}"${done ? ' checked' : ''}><span>${renderInline(taskText, ctx)}</span></label></li>`
          );
        } else {
          addClozeFlashcardsFromLine(rawItem, curLineNo, flashcards, seenCardHashes);
          wordCount += rawItem.split(/\s+/).filter(Boolean).length;
          itemsHtml.push(`<li style="--indent:${indent}">${renderInline(rawItem, ctx)}</li>`);
        }
        i++;
      }
      htmlBlocks.push(`<${tag}${hasTasks ? ' class="task-list"' : ''}>${itemsHtml.join('')}</${tag}>`);
      continue;
    }

    // Paragraph (collect contiguous plain lines)
    const paraLines = [];
    while (i < bodyLines.length) {
      const cur = bodyLines[i];
      const curTrim = cur.trim();
      const curLineNo = bodyStartLine + i;
      if (
        !curTrim ||
        /^(```+|~~~+)/.test(curTrim) ||
        curTrim.startsWith('$$') ||
        /^#{1,6}\s+/.test(cur) ||
        curTrim.startsWith('>') ||
        /^(?:---|\*\*\*|___)\s*$/.test(curTrim) ||
        /^(\s*)(?:[-*+]|\d+\.)\s+/.test(cur) ||
        /^!\[\[[^\]]+\]\]$/.test(curTrim) ||
        (i + 1 < bodyLines.length && bodyLines[i + 1].trim() === '??') ||
        /^(.+?)\s*::\s*(.+)$/.test(cur)
      ) {
        break;
      }
      addClozeFlashcardsFromLine(cur, curLineNo, flashcards, seenCardHashes);
      paraLines.push(curTrim);
      i++;
    }
    const paraText = paraLines.join(' ');
    wordCount += paraText.split(/\s+/).filter(Boolean).length;
    htmlBlocks.push(`<p>${renderInline(paraText, ctx)}</p>`);
  }

  const title = (typeof frontmatter.title === 'string' && frontmatter.title.trim()) || firstH1 || 'Untitled Note';
  return {
    frontmatter,
    title,
    tags: [...ctx.tags],
    links: [...ctx.links.values()],
    embeds: [...ctx.embeds.values()],
    tasks,
    flashcards,
    headings,
    wordCount,
    readingTimeMinutes: Math.max(1, Math.ceil(wordCount / 220)),
    html: htmlBlocks.join('\n')
  };
}

/**
 * Strip YAML frontmatter and Markdown syntax into a clean plain-text excerpt.
 */
export function extractPlainSnippet(content, maxLen = 140) {
  const { bodyLines } = parseFrontmatter(content);
  const plain = bodyLines
    .join(' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, a) => a || t)
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, a) => a || t)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\{\{([^}]+)\}\}/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/(^|\s)[#>|-]+(\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= maxLen) return plain;
  return `${plain.slice(0, maxLen - 1).trimEnd()}…`;
}

/**
 * Toggle a single Markdown task line by 1-based line number cleanly.
 */
export function toggleTaskLine(content, lineNo, done) {
  const normalized = String(content ?? '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const idx = lineNo - 1;
  if (idx < 0 || idx >= lines.length) {
    return { updated: normalized, changed: false };
  }
  const match = lines[idx].match(/^(\s*(?:[-*+]|\d+\.)\s*\[)([ xX])(\]\s*.*)$/);
  if (!match) {
    return { updated: normalized, changed: false };
  }
  const targetChar = done ? 'x' : ' ';
  if (match[2].toLowerCase() === targetChar && match[2] === targetChar) {
    return { updated: normalized, changed: false };
  }
  lines[idx] = `${match[1]}${targetChar}${match[3]}`;
  return { updated: lines.join('\n'), changed: true };
}
