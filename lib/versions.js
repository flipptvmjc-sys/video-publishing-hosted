// Versioning helpers — Wave 2C. Pure functions, no I/O.
//
// 1. Plan versions: a new plan version never silently overwrites an
//    approved caption/plan. diffPlan(prev, next) lists the fields that
//    changed between two plan versions so the desk can show the diff.
// 2. Trend feed: normalizeWatchItem maps a raw network_watch item (new
//    schema or the legacy change/source shape) onto the feed schema
//    (platform, claim, sourceUrl, sourceGrade, publishedAt, observedAt,
//    affectsClients[]). Anything without a source is graded "unverified"
//    — never presented as researched. diffWatchEditions compares two
//    editions by platform+source (or platform+claim when there is no
//    source) so the feed can show what is new, changed, or gone.
//    feedFreshness stamps "last checked X ago, next check Y" (weekly).
const PLAN_FIELDS = [
  ['title', (p) => p.title || ''],
  ['script.hook', (p) => (p.script && p.script.hook) || ''],
  ['script.beats', (p) => (p.script && Array.isArray(p.script.beats) ? p.script.beats.join(' | ') : '')],
  ['script.cta', (p) => (p.script && p.script.cta) || ''],
  ['captions', (p) => (Array.isArray(p.captions) ? p.captions.join(' | ') : (p.captions || ''))],
  ['thumbnail', (p) => JSON.stringify(p.thumbnail || '')],
];

function diffPlan(prev, next) {
  if (!prev) return { previousVersion: null, changed: [] };
  const changed = [];
  for (const [name, get] of PLAN_FIELDS) {
    if (get(prev) !== get(next)) changed.push(name);
  }
  return { previousVersion: prev.version || null, changed };
}

function normalizeWatchItem(raw, nowIso) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const platform = String(r.platform || 'unknown').toLowerCase();
  const claim = String(r.claim || r.change || '').trim();
  const sourceUrl = String(r.sourceUrl || r.source_url || '').trim()
    || (typeof r.source === 'string' && /^https?:\/\//.test(r.source) ? r.source : '');
  const sourceDomain = (!sourceUrl && typeof r.source === 'string' && r.source.trim())
    ? r.source.trim()
    : '';
  let sourceGrade = String(r.sourceGrade || '').toLowerCase();
  if (!['verified', 'sourced', 'unverified'].includes(sourceGrade)) {
    sourceGrade = sourceUrl || sourceDomain ? 'sourced' : 'unverified';
  }
  // An item that claims a source but gives no URL/domain is not sourced.
  if (sourceGrade !== 'unverified' && !sourceUrl && !sourceDomain) sourceGrade = 'unverified';
  let affectsClients = [];
  if (Array.isArray(r.affectsClients)) affectsClients = r.affectsClients.filter((x) => typeof x === 'string');
  else if (typeof r.clientId === 'string') affectsClients = [r.clientId];
  return {
    platform,
    claim,
    sourceUrl,
    source: sourceDomain || (sourceUrl ? sourceUrl.replace(/^https?:\/\//, '').split('/')[0] : ''),
    sourceGrade,
    publishedAt: r.publishedAt || null,
    observedAt: r.observedAt || nowIso,
    affectsClients,
    action: typeof r.action === 'string' ? r.action : '',
  };
}

function watchItemKey(item) {
  const claim = String(item.claim || '').trim().toLowerCase();
  if (item.sourceUrl) return `${item.platform}|${item.sourceUrl.toLowerCase()}`;
  return `${item.platform}|${claim}`;
}

function diffWatchEditions(prevItems, nextItems) {
  const prev = Array.isArray(prevItems) ? prevItems : [];
  const next = Array.isArray(nextItems) ? nextItems : [];
  const prevByKey = new Map(prev.map((it) => [watchItemKey(it), it]));
  const nextByKey = new Map(next.map((it) => [watchItemKey(it), it]));
  const added = [];
  const changed = [];
  const removed = [];
  for (const it of next) {
    const k = watchItemKey(it);
    if (!prevByKey.has(k)) {
      // Same platform + same source domain but different claim text =
      // an update to a known story, not a brand-new item.
      const sameSource = prev.find((p) => p.platform === it.platform
        && p.source && it.source && p.source === it.source
        && String(p.claim) !== String(it.claim));
      if (sameSource) changed.push({ item: it, previousClaim: sameSource.claim });
      else added.push(it);
    }
  }
  for (const it of prev) {
    if (!nextByKey.has(watchItemKey(it))) {
      const wasChanged = changed.some((c) => c.previousClaim === it.claim && c.item.platform === it.platform);
      if (!wasChanged) removed.push(it);
    }
  }
  return { added, changed, removed };
}

const WATCH_INTERVAL_MS = 7 * 24 * 3600 * 1000;

function feedFreshness(editions, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const list = (Array.isArray(editions) ? editions : []).filter((e) => e && e.createdAt);
  if (!list.length) {
    return { lastCheckedAt: null, nextCheckAt: null, checkedAgoMs: null, status: 'never' };
  }
  const lastMs = Math.max(...list.map((e) => new Date(e.createdAt).getTime()));
  const lastCheckedAt = new Date(lastMs).toISOString();
  const nextCheckAt = new Date(lastMs + WATCH_INTERVAL_MS).toISOString();
  return {
    lastCheckedAt,
    nextCheckAt,
    checkedAgoMs: now - lastMs,
    status: now > lastMs + WATCH_INTERVAL_MS ? 'overdue' : 'current',
  };
}

module.exports = { diffPlan, normalizeWatchItem, diffWatchEditions, feedFreshness, WATCH_INTERVAL_MS };
