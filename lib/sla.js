// SLA pause arithmetic — Beyond Copper Branding 3-day clock (Wave 2C).
//
// Rule: blocked videos pause the 3-day clock. The deadline counts only
// UNPAUSED time. A video stores:
//   deadlineAt      — the original 3-day deadline (intake + 72h)
//   pausedAt        — ISO timestamp when the current block started, or null
//   pausedMsTotal   — accumulated paused milliseconds from finished blocks
// The ACTIVE deadline is deadlineAt + pausedMsTotal + (now - pausedAt if
// currently paused). Blocking twice never resets pausedAt; unblocking adds
// exactly the paused interval to pausedMsTotal. Pure functions — no I/O,
// no clock except the `nowMs` the caller passes (tests pass fixed times).
const SLA_MS = 3 * 24 * 3600 * 1000;

function slaInfo(video, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const pausedTotal = Number(video.pausedMsTotal) || 0;
  const currentlyPausedMs = video.pausedAt
    ? Math.max(0, now - new Date(video.pausedAt).getTime())
    : 0;
  const pausedMs = pausedTotal + currentlyPausedMs;
  const deadlineMs = new Date(video.deadlineAt).getTime();
  const deadlineActiveMs = deadlineMs + pausedMs;
  const msRemainingActive = deadlineActiveMs - now;
  return {
    pausedMsTotal: pausedTotal,
    currentlyPausedMs,
    pausedMs,
    deadlineAt: video.deadlineAt || null,
    deadlineActiveAt: new Date(deadlineActiveMs).toISOString(),
    msRemainingActive,
    overdue: msRemainingActive < 0,
    blocked: !!video.pausedAt,
    blockedReason: video.blockedReason || '',
    blockedOwner: video.blockedOwner || '',
  };
}

module.exports = { SLA_MS, slaInfo };
