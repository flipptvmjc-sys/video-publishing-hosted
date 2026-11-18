// Comment intake + replies — Wave 2D. Pure functions, no I/O.
//
// Flow (report §5, §10 direction 3):
//   Meta webhook push -> verify X-Hub-Signature-256 (HMAC-SHA256
//   with the app secret) BEFORE trusting the body -> enqueue ->
//   return 200 fast -> dedupe by message id (Meta retries failed
//   deliveries for up to 36 hours; webhooks have no history, a
//   dropped event cannot be replayed).
//
// Two layers (SocialPilot model):
//   Layer 1 — keyword speed: price / link / info / available get an
//     immediate one-sentence public reply routing to DM. "Immediate"
//     means the text is ready with no model wait — it still lands as
//     a DRAFT. DRAFT-FIRST is absolute: nothing auto-posts, and
//     silence = proceed does NOT cover replies until Michael
//     explicitly decides it.
//   Layer 2 — AI draft: niche + playbook + conversation context,
//     280-char cap, human approval, DO-NOT-SEND guardrail on EVERY
//     path including batch ingest (the ingest guard already exists
//     in server.js ingestJobResult; the webhook path applies the
//     same rule before enqueueing).
//
// Meta limits — VERIFIED at build time (2026-11-17, see notes):
//   - 750 private replies/hour per Instagram professional account
//     (Meta docs, via multiple independent sources checked Oct-Nov
//     2026 all tracing to developers.facebook.com — the Meta pages
//     themselves were not fetched directly; they are JS/login-gated
//     in this environment).
//   - One private reply per comment, within 7 days of the comment;
//     follow-ups only after the person replies, within 24h of it.
//   - Instagram API-published posts: Meta's own docs DISAGREE — the
//     Content Publishing guide's rate-limit section says 100 per
//     24h moving period, while the same guide's carousel section and
//     the content_publishing_limit reference say 50. Resolution:
//     plan against 50, query GET /{ig-user-id}/content_publishing_limit
//     at runtime and respect the live quota_total/quota_usage —
//     never hardcode either number.
//   - Meta publishes 15 Instagram webhook fields; there is NO field
//     for follows, likes, saves, shares, or profile visits — BCB
//     cannot trigger on those at all.

const crypto = require('crypto');

const REPLY_MAX_CHARS = 280;
const PRIVATE_REPLIES_PER_HOUR = 750;
const PRIVATE_REPLY_WINDOW_DAYS = 7;
const FIRST_HOUR_MS = 60 * 60 * 1000;
// Plan against the conservative number; the live quota comes from
// content_publishing_limit at publish time (see note above).
const IG_PUBLISH_PLAN_LIMIT_24H = 50;

// ---------- Webhook signature ----------
// Verifies X-Hub-Signature-256: "sha256=<hex hmac-sha256(rawBody,
// appSecret)>". Constant-time compare; any mismatch (or a missing
// secret/signature) is a rejection — the body is never trusted first.
function verifyMetaSignature({ rawBody, signature, appSecret }) {
  if (!appSecret || !signature) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); }
  catch { return false; }
}

// Meta verification handshake: GET with hub.mode=subscribe,
// hub.verify_token, hub.challenge — echo the challenge only when
// the verify token matches.
function verifyHandshake({ mode, verifyToken, challenge, expectedToken }) {
  if (mode === 'subscribe' && expectedToken && verifyToken === expectedToken && challenge) {
    return { ok: true, challenge };
  }
  return { ok: false };
}

// ---------- Incoming-event normalisation ----------
// Meta posts { object, entry: [{ id, time, messaging: [...],
// changes: [...] }] }. Comments arrive as changes with
// field 'comments' (value: { id, text, from, media: { id } });
// DMs / story replies arrive as messaging entries (message.mid).
// Returns [{ eventId, kind, platform, commentId, from, text,
// mediaId, timestamp }]. Anything unrecognised is skipped — an
// event BCB cannot parse is recorded as ignored, never as a reply.
function normalizeMetaEvents(payload) {
  const out = [];
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.entry)) return out;
  const platform = payload.object === 'instagram' ? 'instagram' : payload.object === 'page' ? 'facebook' : String(payload.object || 'unknown');
  for (const entry of payload.entry) {
    const ts = entry.time ? new Date(entry.time * 1000).toISOString() : new Date().toISOString();
    for (const ch of entry.changes || []) {
      if (ch.field !== 'comments' || !ch.value) continue;
      const v = ch.value;
      const id = String(v.id || v.comment_id || '');
      if (!id) continue;
      out.push({
        eventId: `comment:${id}`,
        kind: 'comment',
        platform,
        commentId: id,
        from: (v.from && (v.from.username || v.from.id)) || 'unknown',
        fromId: (v.from && v.from.id) || null,
        text: String(v.text || v.comment || ''),
        mediaId: (v.media && (v.media.id || v.media.media_id)) || (v.post_id ? String(v.post_id) : null),
        timestamp: ts,
      });
    }
    for (const m of entry.messaging || []) {
      const mid = m.message && m.message.mid;
      if (!mid || !m.message) continue;
      out.push({
        eventId: `message:${mid}`,
        kind: 'dm',
        platform,
        commentId: mid,
        from: (m.sender && m.sender.id) || 'unknown',
        fromId: (m.sender && m.sender.id) || null,
        text: String((m.message && m.message.text) || ''),
        mediaId: null,
        timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : ts,
      });
    }
  }
  return out;
}

// ---------- Layer 1: keyword speed ----------
// One sentence each, always routing to DM. Deterministic — no model
// call, no invention, no promise the coordinator did not approve.
const KEYWORD_RULES = [
  { keywords: ['price', 'pricing', 'cost', 'how much', 'rate'], reply: 'Great question — I just sent you a DM with the pricing details!' },
  { keywords: ['link', 'website', 'where can i buy', 'where do i buy', 'shop'], reply: 'The link is on its way — check your DMs!' },
  { keywords: ['info', 'more info', 'details', 'tell me more', 'how does it work'], reply: 'Happy to share more — I sent you a DM with the details!' },
  { keywords: ['available', 'availability', 'book', 'booking', 'schedule', 'openings'], reply: 'Yes — I sent you a DM so we can check dates!' },
];

function matchKeyword(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  for (const rule of KEYWORD_RULES) {
    for (const kw of rule.keywords) {
      const needle = kw.includes(' ') ? kw : kw;
      if (t.includes(needle)) return { keyword: kw, reply: rule.reply };
    }
  }
  return null;
}

// A comment that must never produce a reply on any path: empty text,
// or text that is only a link/mention with no words. (Spam/hostile
// judgement is the model's DO-NOT-SEND call on the AI path; the
// keyword path never fires on these.)
function isNoReplyComment(text) {
  const t = String(text || '').trim();
  if (!t) return { noReply: true, reason: 'empty comment — nothing to reply to' };
  return { noReply: false };
}

function capReply(text) {
  const t = String(text || '');
  return t.length <= REPLY_MAX_CHARS ? t : `${t.slice(0, REPLY_MAX_CHARS - 1).trimEnd()}…`;
}

// ---------- First-hour timer ----------
// Tied to publishedAt (report §5): the first hour after a post goes
// live is when early replies are a ranking + relationship signal.
// The honest claim is "early replies are a ranking signal" — never
// a promised percentage.
function firstHourInfo(video, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (!video || !video.publishedAt) {
    return { publishedAt: null, endsAt: null, msRemaining: null, active: false, overdue: false };
  }
  const pubMs = new Date(video.publishedAt).getTime();
  const endsMs = pubMs + FIRST_HOUR_MS;
  return {
    publishedAt: video.publishedAt,
    endsAt: new Date(endsMs).toISOString(),
    msRemaining: endsMs - now,
    active: now >= pubMs && now < endsMs,
    overdue: now >= endsMs,
  };
}

// Pure: decide what the intake does with one normalised event.
// Returns { action: 'keyword_draft' | 'ai_job' | 'ignored',
//           replyText?, reason? } — the caller creates the record.
function decideIntakeAction(event) {
  const noReply = isNoReplyComment(event.text);
  if (noReply.noReply) return { action: 'ignored', reason: noReply.reason };
  const kw = matchKeyword(event.text);
  if (kw) return { action: 'keyword_draft', replyText: kw.reply, keyword: kw.keyword };
  return { action: 'ai_job', reason: 'no keyword match — AI draft layer' };
}

module.exports = {
  REPLY_MAX_CHARS,
  PRIVATE_REPLIES_PER_HOUR,
  PRIVATE_REPLY_WINDOW_DAYS,
  FIRST_HOUR_MS,
  IG_PUBLISH_PLAN_LIMIT_24H,
  KEYWORD_RULES,
  verifyMetaSignature,
  verifyHandshake,
  normalizeMetaEvents,
  matchKeyword,
  isNoReplyComment,
  capReply,
  firstHourInfo,
  decideIntakeAction,
};
