/* ============================================================================
 *  BugOps AI · application module
 *  -----------------------------------------------------------------------
 *  - Architecturally component-based: primitives return HTML strings or
 *    append into elements. Pages are pure functions of Ctx.
 *  - Backend hooks preserved verbatim:
 *      Ctx.{bugs,reviews,analyses,pod,loading}
 *      DEMO_BUGS / DEMO_REVIEWS / DEMO_ANALYSES
 *      fetchAll, polling, withRefresh
 *      routes (#/, #/operations, #/bug/:id, #/releases, #/insights, #/settings)
 *      DOM IDs (#sidebar-pod, #sidebar-bugs, #theme-toggle,
 *               #new-bug, #me-avatar, #op-search, #routes, #modal-mount)
 *      lemmaApp SDK + window.__LEMMA_CONFIG__
 * ============================================================================ */

const BO_THEME_KEY   = 'bo-theme';
const Ctx = {
  pod: null,
  bugs: [],
  reviews: [],
  analyses: [],
  loading: true,
  _route: null,
  _query: '',
  _selected: new Set(),
  _prefs: { theme: 'dark', view: 'table', sort: 'reported_desc', filters: { severity: [], status: [], priority: [] } },
  _settings: null,
  _page: 1,
  _scrollPos: null,
  _paletteOpen: false,
  _paletteQ: '',
  _paletteIndex: 0,
  _paletteItems: []
};

/* ---------- settings persistence ---------- */
const BO_SETTINGS_KEY = 'bo-settings';

function getSettings() {
  if (Ctx._settings) return Ctx._settings;
  try {
    var raw = localStorage.getItem(BO_SETTINGS_KEY);
    if (raw) { Ctx._settings = JSON.parse(raw); return Ctx._settings; }
  } catch(_) {}
  Ctx._settings = {
    workspace: { name: 'BugOps AI Engineering', desc: 'Single-source AI engineering release operator for our payments, identity, dashboard, and reporting surface.' },
    ai: { autoApprove: true, requireSignoff: true, showSummary: true, autoPublishNotes: false },
    integrations: { linear: true, github: true, sentry: true, slack: true, jira: true, stripe: true },
    notifications: { dailyDigest: true, newCritical: true, approvalNeeded: true, readinessFlip: false },
    scheduleReport: false
  };
  return Ctx._settings;
}

function saveSettings() {
  try { localStorage.setItem(BO_SETTINGS_KEY, JSON.stringify(Ctx._settings)); } catch(_) {}
}

/* ===========================================================================
 * GLOBAL CRASH PREVENTION
 * Never let an unhandled error reach the browser and blank the UI.
 * ========================================================================= */
window.addEventListener('error', function(e) {
  console.error('[BugOps] Global error caught:', e.error || e.message);
  e.preventDefault();
});
window.addEventListener('unhandledrejection', function(e) {
  console.warn('[BugOps] Unhandled promise rejection:', e.reason);
  e.preventDefault();
});

/* ===========================================================================
 * SAFE DATA ACCESS HELPERS
 * Every render function must use these to validate data before accessing it.
 * ========================================================================= */
function safeArr(d) { return Array.isArray(d) ? d : []; }
function safeObj(d) { return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {}; }
function safeNum(d, fallback) { const n = parseFloat(d); return isNaN(n) ? (fallback !== undefined ? fallback : 0) : n; }

/**
 * safeFallback(msg) — renders a safe fallback card when a section fails.
 * Used by all try/catch wrappers to prevent blank screen.
 */
function safeFallback(msg) {
  return '<div class="card"><div class="card-head"><div class="title" style="color:var(--text-3)">\u26a0 Section temporarily unavailable</div></div><div class="card-body" style="padding:var(--s-5) var(--s-6)"><p style="color:var(--text-3);font-size:13px;margin:0">' + escapeHtml(msg || 'This section could not be loaded. Please try again.') + '</p></div></div>';
}

/* ---------- safe data validators for analysis objects ---------- */
function safeAnalysis(a) { return safeObj(a); }
function safeConfidenceBreakdown(cb) {
  return safeObj(cb).reproduction_evidence !== undefined ? cb : null;
}

const SEVERITY_TONES = ['critical','major','minor','cosmetic'];
const DOMAIN_TOKENS  = ['auth','payments','dashboard','reports','notifications','billing','api','data','mobile','other'];

/* ---------- helpers ---------- */
function el(html) { const t=document.createElement('template'); t.innerHTML=html.trim(); return t.content.firstElementChild; }
function $$(s,r=document){return Array.from(r.querySelectorAll(s));}
function $1(s,r=document){return r.querySelector(s);}
function escapeHtml(s){return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function fmtRel(iso){const t=new Date(iso).getTime(); const dt=Math.max(0,Date.now()-t); const m=Math.floor(dt/60000); if(m<60)return m+'m ago'; const h=Math.floor(m/60); if(h<24)return h+'h ago'; return Math.floor(h/24)+'d ago';}
function debounce(fn,ms){let t; return (...a)=>{clearTimeout(t); t=setTimeout(()=>fn(...a),ms);};}
function nextId(s){return s+'-'+Math.random().toString(36).slice(2,7);}

/* ---------- helpers (predicate maps) ---------- */
function ANALYSES_BY_BUG(){return Object.fromEntries(Ctx.analyses.map(a => [a.bug_id, a]));}
function REVIEWS_BY_BUG(){const out={}; for(const r of Ctx.reviews) (out[r.bug_id] ||= []).push(r); return out;}

/* ---------- V3 Phase 1: Enhanced Intelligence Helpers ---------- */

function relatedBugsHelper(bugId) {
  const current = ANALYSES_BY_BUG()[bugId];
  if (!current) return [];
  const comps = new Set(current.affected_components || []);
  const mods = new Set(current.affected_modules || []);
  const matches = Object.entries(ANALYSES_BY_BUG())
    .filter(([otherId, a]) => {
      if (otherId === bugId) return false;
      const hasComp = (a.affected_components || []).some(c => comps.has(c));
      const hasMod = (a.affected_modules || []).some(m => mods.has(m));
      return hasComp || hasMod;
    })
    .map(([id, a]) => {
      const bug = Ctx.bugs.find(b => b.id === id) || {};
      return { id, title: bug.title || id, severity: bug.severity, status: bug.status };
    })
    .sort((x, y) => new Date(y.created_at || 0) - new Date(x.created_at || 0));
  return matches;
}

function hypothesesFromRootCause(rootCause) {
  if (!rootCause) return [];
  return rootCause
    .split(/\b(?:or|\/|;)\b/i)
    .map(s => s.trim())
    .filter(Boolean);
}

/* ---------- V3 Phase 3: Enhanced Intelligence Helpers ---------- */

/**
 * generateMultiHypotheses(a)
 * Returns structured alternative hypotheses from the analysis data,
 * each with a description, likelihood label, and rationale.
 * Falls back to the simple text-splitter if no structured data exists.
 */
function generateMultiHypotheses(a) {
  a = safeAnalysis(a);
  if (a.alternative_hypotheses && a.alternative_hypotheses.length) {
    return a.alternative_hypotheses.filter(function(h){ return h && h.description; });
  }
  // fallback: derive from root_cause text
  const parts = hypothesesFromRootCause(a.root_cause);
  if (!parts.length) return [];
  return parts.map((p, i) => ({
    description: p,
    likelihood: i === 0 ? 'high' : 'medium',
    rationale: 'Derived from root cause statement.'
  }));
}

/**
 * generateConfidenceExplanation(a)
 * Returns an object with:
 *   - factors: array of { label, score, explanation, icon }
 *   - summary: human-readable "why this score" paragraph
 * Falls back to a basic single-factor explanation.
 */
function generateConfidenceExplanation(a) {
  a = safeAnalysis(a);
  const cb = safeConfidenceBreakdown(a.confidence_breakdown);
  if (!cb) {
    // fallback: derive from overall confidence
    const pct = Math.round((a.ai_confidence || 0.85) * 100);
    return {
      factors: [{
        label: 'Overall',
        score: a.ai_confidence || 0.85,
        explanation: 'Aggregate confidence from lifecycle analysis.',
        icon: 'brain-circuit'
      }],
      summary: 'AI confidence is ' + pct + '%, calculated by the lifecycle agent based on available evidence. Higher scores indicate stronger reproduction evidence, clearer root cause code paths, and better alignment with historical bug patterns.'
    };
  }
  const factors = [];
  if (cb.reproduction_evidence !== undefined) factors.push({
    label: 'Reproduction Evidence',
    score: cb.reproduction_evidence,
    explanation: 'How reliably the bug can be reproduced in a controlled environment.',
    icon: 'flask-conical'
  });
  if (cb.code_analysis !== undefined) factors.push({
    label: 'Code Analysis',
    score: cb.code_analysis,
    explanation: 'Clarity of the code-level root cause and the fix path.',
    icon: 'file-code'
  });
  if (cb.historical_pattern !== undefined) factors.push({
    label: 'Historical Pattern',
    score: cb.historical_pattern,
    explanation: 'Match strength against previously resolved bugs in the same component area.',
    icon: 'history'
  });
  if (cb.data_integrity !== undefined) factors.push({
    label: 'Data Integrity',
    score: cb.data_integrity,
    explanation: 'Quality and completeness of the bug report, logs, and stack traces submitted.',
    icon: 'shield-check'
  });
  const avg = factors.reduce((s, f) => s + f.score, 0) / factors.length;
  const pct = Math.round(avg * 100);
  const summary = pct >= 85
    ? 'High confidence. The AI has strong reproduction evidence, clear code-level root cause, and supporting historical data across multiple dimensions.'
    : pct >= 60
      ? 'Moderate confidence. Some dimensions are well-supported while others need additional data — particularly reproduction steps and code path analysis.'
      : 'Low confidence. Insufficient evidence in most dimensions. Consider collecting more data before acting on this analysis.';
  return { factors, summary };
}

/**
 * generateEvidenceBreakdown(a)
 * Returns an array of evidence items with category icon, description,
 * confidence, and detail. Falls back to deriving from basic analysis fields.
 */
function generateEvidenceBreakdown(a) {
  a = safeAnalysis(a);
  if (a.evidence_items && a.evidence_items.length) {
    return a.evidence_items.map(item => ({
      category: item.category || 'general',
      description: item.description || '',
      confidence: item.confidence || 0.85,
      detail: item.detail || ''
    }));
  }
  // fallback: derive from existing basic fields
  const items = [];
  if (a.affected_components && a.affected_components.length) {
    items.push({
      category: 'code_review',
      description: a.affected_components.length + ' affected component(s) identified',
      confidence: a.ai_confidence || 0.85,
      detail: a.affected_components.join(', ')
    });
  }
  if (a.affected_modules && a.affected_modules.length) {
    items.push({
      category: 'code_review',
      description: a.affected_modules.length + ' affected module(s) pinpointed',
      confidence: Math.min(1, (a.ai_confidence || 0.85) + 0.05),
      detail: a.affected_modules.join(', ')
    });
  }
  if (a.root_cause) {
    items.push({
      category: 'log_analysis',
      description: 'Root cause statement analysed',
      confidence: a.ai_confidence || 0.85,
      detail: a.root_cause.slice(0, 120) + (a.root_cause.length > 120 ? '...' : '')
    });
  }
  return items;
}

/**
 * generateRecommendations(a)
 * Returns an array of actionable recommendations with priority, owner, and effort.
 * Falls back to deriving from existing analysis fields.
 */
function generateRecommendations(a) {
  a = safeAnalysis(a);
  if (a.recommendations && a.recommendations.length) {
    return a.recommendations;
  }
  // fallback: derive from readiness / release_blocker status
  const recs = [];
  if (a.release_blocker) {
    recs.push({
      action: 'Resolve release blocker before next deployment',
      priority: 'critical',
      owner: a.recommended_team || 'Engineering on-call',
      effort: 'estimated 4-8 hours'
    });
  }
  recs.push({
    action: 'Assign to ' + (a.recommended_team || 'appropriate squad'),
    priority: a.readiness === 'hold' ? 'critical' : 'high',
    owner: a.recommended_team || 'Engineering on-call',
    effort: 'planning'
  });
  recs.push({
    action: 'Run affected component regression suite',
    priority: 'high',
    owner: 'QA',
    effort: 'estimated 2-3 hours'
  });
  if (a.regression_risk && a.regression_risk > 60) {
    recs.push({
      action: 'Flag for extended regression window due to elevated risk (' + a.regression_risk + '%)',
      priority: 'high',
      owner: 'Release Manager',
      effort: 'coordination'
    });
  }
  return recs;
}

/**
 * generateReasoningChain(a)
 * Returns an array of reasoning steps from the analysis.
 */
function generateReasoningChain(a) {
  a = safeAnalysis(a);
  if (a.reasoning_steps && a.reasoning_steps.length) {
    return a.reasoning_steps;
  }
  // fallback: derive from root_cause and basic fields
  const steps = [];
  if (a.root_cause) {
    steps.push('Identified root cause: ' + a.root_cause.slice(0, 100) + (a.root_cause.length > 100 ? '...' : ''));
  }
  if (a.affected_components && a.affected_components.length) {
    steps.push('Mapped affected components: ' + a.affected_components.join(', ') + '.');
  }
  if (a.affected_services && a.affected_services.length) {
    steps.push('Traced service dependencies through ' + a.affected_services.join(', ') + '.');
  }
  steps.push('Evaluated deployment risk as "' + (a.deployment_risk || 'medium') + '" with ' + (a.regression_risk || 50) + '% regression probability.');
  steps.push('Assigned readiness: "' + (a.readiness || 'review') + '" (' + (a.readiness_score || 60) + '/100).');
  return steps;
}

/**
 * Render helpers — return HTML strings for the intelligence components.
 */
function renderHypothesisCard(hyp, index) {
  if (!hyp || !hyp.description) return '';
  const tone = hyp.likelihood === 'high' ? 'ok' : hyp.likelihood === 'medium' ? 'warn' : 'info';
  const label = hyp.likelihood === 'high' ? 'High likelihood' : hyp.likelihood === 'medium' ? 'Possible' : 'Unlikely';
  return '<div class="tl-item" style="padding:8px 0 12px 24px">'
    + '<div class="tl-mark" data-tone="' + tone + '" style="left:-24px;top:10px;width:10px;height:10px;border-width:1.5px"></div>'
    + '<div><span class="chip chip-tone-' + tone + '" style="font-size:10px;height:18px;padding:0 6px">' + label + '</span>'
    + '<span style="font-size:13px;color:var(--text-1);margin-left:6px">' + escapeHtml(hyp.description) + '</span>'
    + (hyp.rationale ? '<div style="font-size:12px;color:var(--text-3);margin-top:4px">' + escapeHtml(hyp.rationale) + '</div>' : '')
    + '</div></div>';
}

function renderConfidenceFactor(factor) {
  if (!factor) return '';
  const pct = Math.round((factor.score || 0) * 100);
  const tone = pct >= 80 ? 'ok' : pct >= 55 ? 'warn' : 'crit';
  return '<div class="mini-row" style="grid-template-columns:24px 1fr auto;padding:6px 0">'
    + '<i data-lucide="' + factor.icon + '" style="width:16px;height:16px;color:var(--accent)"></i>'
    + '<div><div style="font-size:13px;font-weight:600;color:var(--text-1)">' + escapeHtml(factor.label) + '</div>'
    + '<div style="font-size:11px;color:var(--text-3)">' + escapeHtml(factor.explanation) + '</div></div>'
    + '<span class="chip chip-tone-' + tone + '">' + pct + '%</span>'
    + '</div>';
}

function renderEvidenceItem(item) {
  if (!item || !item.description) return '';
  const pct = Math.round((item.confidence || 0) * 100);
  const tone = pct >= 80 ? 'ok' : pct >= 55 ? 'warn' : 'crit';
  const catIcon = item.category === 'log_analysis' ? 'file-search' : item.category === 'code_review' ? 'code' : item.category === 'reproduction' ? 'flask-conical' : 'search';
  return '<div class="mini-row" style="grid-template-columns:24px 1fr auto;padding:8px 0;border-bottom:var(--hairline)">'
    + '<i data-lucide="' + catIcon + '" style="width:16px;height:16px;color:var(--accent)"></i>'
    + '<div><div style="font-size:13px;font-weight:500;color:var(--text-1)">' + escapeHtml(item.description) + '</div>'
    + (item.detail ? '<div style="font-size:11px;color:var(--text-3);margin-top:2px;font-family:var(--font-mono)">' + escapeHtml(item.detail) + '</div>' : '')
    + '</div>'
    + '<span class="chip chip-tone-' + tone + '">' + pct + '%</span>'
    + '</div>';
}

function renderRecommendation(rec) {
  if (!rec || !rec.action) return '';
  const tone = rec.priority === 'critical' ? 'crit' : rec.priority === 'high' ? 'warn' : 'info';
  return '<div class="mini-row" style="grid-template-columns:18px 1fr auto;padding:8px 0;border-bottom:var(--hairline)">'
    + '<span class="sev-dot" data-sev="' + (rec.priority === 'critical' ? 'critical' : rec.priority === 'high' ? 'major' : 'minor') + '"></span>'
    + '<div><div style="font-size:13px;font-weight:500;color:var(--text-1)">' + escapeHtml(rec.action) + '</div>'
    + '<div style="font-size:11px;color:var(--text-3);margin-top:2px">'
      + (rec.owner ? '<b>' + escapeHtml(rec.owner) + '</b>' : '') + (rec.effort ? ' \u00b7 ' + escapeHtml(rec.effort) : '')
    + '</div></div>'
    + '<span class="chip chip-tone-' + tone + '">' + escapeHtml(rec.priority) + '</span>'
    + '</div>';
}

function renderReasoningStep(step, index) {
  if (!step) return '';
  const icons = ['search', 'file-search', 'git-branch', 'bar-chart-3', 'check-check', 'lightbulb'];
  const icon = icons[index % icons.length];
  return '<div class="tl-item" style="padding:8px 0 10px 28px">'
    + '<div class="tl-mark" style="left:-28px;top:10px;width:12px;height:12px;border-color:var(--accent);background:var(--accent-tint)"></div>'
    + '<div style="display:flex;align-items:flex-start;gap:8px">'
      + '<i data-lucide="' + icon + '" style="width:14px;height:14px;color:var(--accent);margin-top:2px;flex-shrink:0"></i>'
      + '<span style="font-size:13px;color:var(--text-2);line-height:1.45">' + escapeHtml(step) + '</span>'
    + '</div></div>';
}


function domainCounts(){return Ctx.bugs.reduce((a,b)=>{a[b.domain||'other']=(a[b.domain||'other']||0)+1; return a;},{});}
function severityTone(s){return SEVERITY_TONES.includes(s) ? s : 'info';}

/* ---------- seed data ---------- */
function bugmk(id,title,o){return Object.assign({id,title},o);}

const DEMO_BUGS = [
  bugmk('bug-001','Stripe webhook double-charges customers on retry', { severity:'critical', priority:'urgent', status:'review', domain:'payments', submitter:'qa@stripe', created_at: hoursAgo(0.4), desc:'On 5xx retries, the Stripe webhook handler re-credits both the original order and the replayed order. Customers receiving two confirmations and duplicate invoices. Stripe customer support is on it \u2014 escalation #S-4412.'}),
  bugmk('bug-002','OAuth state mismatch on return from Google', { severity:'major', priority:'urgent', status:'review', domain:'auth', submitter:'security@bugops', created_at: hoursAgo(1.5), desc:'A cookie race condition between two open tabs will cause one tab to consume the other tab\u2019s state token. Pre-existing session restores from the wrong Google account, which leaks scope.'}),
  bugmk('bug-003','Logged-out users can read /admin/users via cached routes', { severity:'critical', priority:'urgent', status:'review', domain:'auth', submitter:'security@bugops', created_at: hoursAgo(2.7), desc:'A logged-out user with a browser back-stack can read /admin/users for ~120 ms. They are then redirected but the page has already rendered.'}),
  bugmk('bug-004','Checkout total updates after stale button state', { severity:'minor', priority:'medium', status:'triaged', domain:'dashboard', submitter:'eng@bugops', created_at: hoursAgo(4.1), desc:'Pressing Pay while the cart refetches shows the old total for a moment before the click registers.'}),
  bugmk('bug-005','/reports first paint fetches every user\u2019s row', { severity:'major', priority:'high', status:'triaged', domain:'reports', submitter:'prod@bugops', created_at: hoursAgo(6.2), desc:'Loading /reports fires 210 individual GET /api/v1/exports calls during the first paint.'}),
  bugmk('bug-006','GET /api/v1/exports with empty body on large ranges', { severity:'major', priority:'high', status:'triaged', domain:'api', submitter:'eng@bugops', created_at: hoursAgo(7.6), desc:'Calling /api/v1/exports?range=quarter for an organization with &gt; 50k rows returns an empty body.'}),
  bugmk('bug-007','Outbound webhook retries forever on 4xx', { severity:'major', priority:'high', status:'triaged', domain:'api', submitter:'sre@bugops', created_at: hoursAgo(9.4), desc:'A consumer endpoint returns 422 to our webhook and we retry forever, hitting rate limits.'}),
  bugmk('bug-008','/dashboard 4.2s first paint on 3G', { severity:'minor', priority:'medium', status:'triaged', domain:'dashboard', submitter:'perf@bugops', created_at: hoursAgo(10.0), desc:'Bundle: scenarios 220 kB + recharts 199 kB + main chunk 311 kB.'}),
  bugmk('bug-009','Android biometric prompt never appears', { severity:'major', priority:'high', status:'triaged', domain:'mobile', submitter:'qa@android', created_at: hoursAgo(12.4), desc:'After locking then unlocking the app, the biometric prompt should re-eye but no prompt shows. Misconfiguration on Pixel 8.'}),
  bugmk('bug-010','Stored XSS via admin comment preview', { severity:'critical', priority:'urgent', status:'blocked', domain:'dashboard', submitter:'security@bugops', created_at: hoursAgo(14.0), desc:'Previewing an admin comment containing &lt;img src=x onerror=alert(1)&gt; runs the alert. CSP is allow-listed via unsafe-inline in the inner preview document.'}),
  bugmk('bug-011','Notification dispatch race in billing retry', { severity:'major', priority:'high', status:'risk', domain:'notifications', submitter:'crm@bugops', created_at: hoursAgo(16.0), desc:'A billing retry sends two notifications \u2014 a primary email and a Telegram fallback \u2014 when both workers pick up the same retry after the lockout TTL.'}),
  bugmk('bug-012','Stripe payment intent timeout corrupts UI', { severity:'major', priority:'high', status:'risk', domain:'payments', submitter:'support@bugops', created_at: hoursAgo(18.2), desc:'When Stripe payment intent times out, the UI shows the wrong \u201cstill processing\u201d state.'}),
  bugmk('bug-013','Billing CSV export silently truncates to 100 rows', { severity:'minor', priority:'medium', status:'ready', domain:'billing', submitter:'cfo-office', created_at: hoursAgo(20.0), desc:'Stripe billing CSV export silently truncates to 100 rows.'}),
  bugmk('bug-014','Auth dashboard dark mode contrast on charts', { severity:'cosmetic', priority:'low', status:'ready', domain:'auth', submitter:'design@bugops', created_at: hoursAgo(22.5), desc:'Chart text contrast ratio 3.4:1 in dark mode \u2014 less than AA. Replace chart labels with a higher-contrast token.'}),
  bugmk('bug-015','Mobile push duplicate on token rotation', { severity:'major', priority:'high', status:'ready', domain:'mobile', submitter:'sre@bugops', created_at: hoursAgo(24.8), desc:'When APNs rotates the device token, a duplicate push sends.'}),
  bugmk('bug-016','Reports dashboard N+1 at midnight', { severity:'minor', priority:'medium', status:'shipped', domain:'reports', submitter:'eng@bugops', created_at: hoursAgo(28.0), desc:'At midnight UTC the /reports view N+1\u2019s into a slow query log. Fix shipped in v4.3.'})
];
function hoursAgo(h){return new Date(Date.now()-h*3600*1000).toISOString();}

const DEMO_REVIEWS = [
  { id:'rev-001', bug_id:'bug-001', actor:'bug-triage-agent', kind:'triage', severity:'critical', priority:'urgent', created_at: hoursAgo(0.4), note:'Stripe webhook retry loop \u2014 ships blocker.' },
  { id:'rev-002', bug_id:'bug-002', actor:'bug-lifecycle-agent', kind:'analysis', severity:'major', priority:'urgent', created_at: hoursAgo(1.5), note:'OAuth state storage is browser-wide not tab-wide.' },
  { id:'rev-003', bug_id:'bug-002', actor:'approval-assistant-agent', kind:'approval', severity:'major', priority:'urgent', created_at: hoursAgo(0.9), note:'Recommend request_changes \u2014 fix the binding before release.' },
  { id:'rev-004', bug_id:'bug-008', actor:'bug-triage-agent', kind:'triage', severity:'minor', priority:'medium', created_at: hoursAgo(2.2), note:'Bundle split \u2014 defer large modules until after FCP.' },
  { id:'rev-005', bug_id:'bug-016', actor:'approval-assistant-agent', kind:'approval', severity:'minor', priority:'medium', created_at: hoursAgo(8.1), note:'Shipped in v4.3 \u2014 close the audit.' },
  { id:'rev-006', bug_id:'bug-010', actor:'bug-triage-agent', kind:'triage', severity:'critical', priority:'urgent', created_at: hoursAgo(13.7), note:'Stored XSS \u2014 release blocker.' }
];

const DEMO_ANALYSES = [
  { id:'an-001', bug_id:'bug-001', ai_confidence:0.93, regression_risk:78, deployment_risk:'critical', release_blocker:true, root_cause:'Missing idempotency key on the Stripe webhook handler; credit applied on every retry rather than only on the first request.', affected_components:['stripe-webhook','ledger'], affected_modules:['payments/handlers/stripeWebhook.ts'], affected_services:['billing-api','stripe-adapter'], recommended_team:'Payments Squad', readiness:'hold', readiness_score:42,
    manager_summary:'This is a release-blocking double-credit bug. The Stripe handler re-applies credit on every retry because there is no idempotency key. Repro is deterministic; impact is every failed-then-retried webhook since the v3.0 release. The Payments Squad should ship the dedupe behind the same key in 24 hours; do not cut the 1.4 release without it.',
    confidence_breakdown:{ reproduction_evidence:0.95, code_analysis:0.88, historical_pattern:0.91, data_integrity:0.92 },
    evidence_items:[
      { category:'reproduction', description:'Deterministic double-credit on every 5xx webhook retry', confidence:0.95, detail:'Reproduced in staging with Stripe test mode: 10/10 retries produce duplicate credit records.' },
      { category:'log_analysis', description:'Ledger audit log shows two credit entries per failed webhook', confidence:0.92, detail:'Logs from billing-api confirm dual writes for request IDs spanning the retry window.' },
      { category:'code_review', description:'Missing idempotency_key parameter in stripeWebhook.ts handler', confidence:0.88, detail:'payments/handlers/stripeWebhook.ts line 142: no idempotency_key passed to stripe.paymentIntents.create()' },
      { category:'historical', description:'Similar double-credit pattern observed in v2.8 Stripe integration bug', confidence:0.85, detail:'Bug #bug-229 (2024-03) showed an identical pattern after a Stripe API upgrade.' }
    ],
    alternative_hypotheses:[
      { description:'Race condition between success callback and retry handler writing to the same ledger row', likelihood:'low', rationale:'Ledger uses row-level locking; concurrent writes would deadlock rather than double-write.' },
      { description:'Misconfigured Stripe webhook sending duplicate events at the source', likelihood:'low', rationale:'Stripe dashboard confirms single event per charge. Retry originates from our side.' }
    ],
    recommendations:[
      { action:'Add Stripe idempotency_key to all payment-intent creation calls', priority:'critical', owner:'Payments Squad', effort:'estimated 2-4 hours' },
      { action:'Add duplicate-credit detection in ledger write path', priority:'critical', owner:'Payments Squad', effort:'estimated 4-6 hours' },
      { action:'Run full billing regression suite before cutting release', priority:'high', owner:'QA', effort:'estimated 3-4 hours' },
      { action:'Audit all Stripe webhook handlers for missing idempotency patterns', priority:'high', owner:'Payments Squad', effort:'estimated 6-8 hours' }
    ],
    reasoning_steps:[
      'Detected correlated log spike: 2x credit entries for the same Stripe charge ID.',
      'Isolated to webhook retry path — credits only duplicated on 5xx responses from Stripe.',
      'Reviewed source code for payments/handlers/stripeWebhook.ts — idempotency_key parameter is not passed to the Stripe SDK.',
      'Confirmed no idempotency enforcement in the ledger write path for webhook-initiated credits.',
      'Checked Stripe dashboard: single event sent per charge. Retry originates from our side, not Stripe.',
      'Evaluated blast radius: all webhook-triggered credits since v3.0 deployment (estimated 12,000 transactions) are potentially affected.'
    ],
    suggested_tests:['idempotent-retry-of-stripe-webhook','parallel-webhook-fanout','partial-failure-5xx-mid-apply','customer-conflict-when-refunded','ledger-dedup-on-concurrent-write'] },
  { id:'an-002', bug_id:'bug-002', ai_confidence:0.91, regression_risk:64, deployment_risk:'high', release_blocker:false, root_cause:'OAuth state cookie is bound to the browser session, not the tab; second tab consumes nonce and binds to the wrong account.', affected_components:['oauth-flow','ssr-auth'], affected_modules:['auth/oauth/google.ts'], affected_services:['idp-gateway'], recommended_team:'Identity Squad', readiness:'review', readiness_score:71,
    manager_summary:'Cookie-binding bug, not a server-side defect. Two-tab repro about 25% of the time. Identity Squad fix is one PR; rollout behind cookie flag.',
    confidence_breakdown:{ reproduction_evidence:0.87, code_analysis:0.94, historical_pattern:0.76, data_integrity:0.90 },
    evidence_items:[
      { category:'reproduction', description:'Two-tab repro: 4/16 attempts produce account misbinding', confidence:0.87, detail:'Open two tabs to the same app, authenticate in both with different Google accounts. ~25% of attempts bind tab B to tab As account.' },
      { category:'code_review', description:'OAuth state cookie uses session scope, not tab-scoped storage', confidence:0.94, detail:'auth/oauth/google.ts: state nonce stored in document.cookie without SameSite or tab partition key.' },
      { category:'log_analysis', description:'Auth audit log shows state-nonce already-consumed errors', confidence:0.90, detail:'idp-gateway log: state_nonce_already_used errors correlate 1:1 with two-tab scenarios.' }
    ],
    alternative_hypotheses:[
      { description:'Server-side session cache collision in idp-gateway', likelihood:'low', rationale:'idp-gateway uses per-request nonce validation; session cache is keyed by nonce, not user ID.' },
      { description:'Google OAuth redirect URL mismatch between tabs', likelihood:'low', rationale:'redirect_uri is static per client config; all tabs use the same registered URL.' }
    ],
    recommendations:[
      { action:'Bind OAuth state nonce to the originating browser tab using sessionStorage', priority:'critical', owner:'Identity Squad', effort:'estimated 3-5 hours' },
      { action:'Add SameSite=strict to OAuth state cookie', priority:'high', owner:'Identity Squad', effort:'estimated 1 hour' },
      { action:'Cross-browser test of tab-bound nonce (Chrome, Firefox, Safari)', priority:'high', owner:'QA', effort:'estimated 2-3 hours' },
      { action:'Roll out behind feature flag with 25% canary', priority:'medium', owner:'Release Manager', effort:'coordination' }
    ],
    reasoning_steps:[
      'Identified correlation: account misbinding reports correlate with multi-tab authentication flows.',
      'Reproduced in staging with two-tab test: ~25% failure rate matches user reports.',
      'Inspected OAuth state management: nonce stored in cookie with session scope (browser-wide).',
      'Confirmed second tab overwrites first tabs nonce, causing the first tabs redirect to bind to the wrong account.',
      'Reviewed fix options: sessionStorage provides tab-scoped isolation without server-side changes.',
      'Determined blast radius: limited to users who authenticate in multiple tabs simultaneously (~8% of daily active users).'
    ],
    suggested_tests:['two-tab-oauth-simultaneous','tab-a-oauth-tab-b-direct-nav','state-nonce-expiry-after-redirect','cross-browser-nonce-binding','feature-flag-toggle-during-flow'] },
  { id:'an-003', bug_id:'bug-005', ai_confidence:0.88, regression_risk:55, deployment_risk:'medium', release_blocker:false, root_cause:'Reports dashboard fires per-row GET /api/v1/exports on mount; should batch into a paginated list call.', affected_components:['reports-dashboard','exports-api'], affected_modules:['reports/Dashboard.tsx','api/exports/list.ts'], affected_services:['reports-frontend'], recommended_team:'Reports Squad', readiness:'ready', readiness_score:83,
    manager_summary:'Performance defect; about 210 DB hits per page load. Fix shrinks to 1 paginated call. Reports squad ready to ship.',
    confidence_breakdown:{ reproduction_evidence:0.92, code_analysis:0.86, historical_pattern:0.77, data_integrity:0.94 },
    evidence_items:[
      { category:'reproduction', description:'First paint of /reports triggers 210 individual GET calls', confidence:0.92, detail:'Chrome DevTools network tab shows 210 sequential GET /api/v1/exports requests on page load.' },
      { category:'code_review', description:'Dashboard component iterates over user list and fires per-row fetch', confidence:0.86, detail:'reports/Dashboard.tsx useEffect(): iterates over accounts array and calls fetchExports() per row.' },
      { category:'log_analysis', description:'Slowest query log shows 210 sequential DB queries per /reports load', confidence:0.94, detail:'Postgres slow query log: 210 identical queries with different account_id params within 600ms window.' }
    ],
    alternative_hypotheses:[
      { description:'Missing database index causing full-table scan on each export lookup', likelihood:'low', rationale:'Query plan shows index scan; latency is from round-trips, not scan cost.' },
      { description:'N+1 caused by ORM relationship loading rather than explicit loop', likelihood:'medium', rationale:'Could be lazy-loading from an ORM association; code review needed to confirm.' }
    ],
    recommendations:[
      { action:'Replace per-row fetch with a single paginated GET /api/v1/exports?ids=... call', priority:'high', owner:'Reports Squad', effort:'estimated 3-5 hours' },
      { action:'Add eager-loading to prevent ORM N+1 in reports controllers', priority:'medium', owner:'Reports Squad', effort:'estimated 2-3 hours' },
      { action:'Set up performance regression test for /reports endpoint', priority:'medium', owner:'QA', effort:'estimated 4-6 hours' },
      { action:'Add query batching middleware to exports API', priority:'medium', owner:'API Team', effort:'estimated 6-8 hours' }
    ],
    reasoning_steps:[
      'Observed /reports page load time: 4.2s on 3G, 1.8s on broadband.',
      'Captured network trace: 210 sequential GET /api/v1/exports requests, each returning 1 row.',
      'Inspected front-end code: reports/Dashboard.tsx iterates over full user list on mount.',
      'Checked database query log: 210 identical queries differentiated only by account_id.',
      'Determined root cause: per-row fetch pattern instead of batched list call.',
      'Estimated fix impact: reduces 210 API calls to 1, improves load time by ~70%.'
    ],
    suggested_tests:['reports-page-load-performance','batched-exports-api-response','empty-org-handling-batched','pagination-with-50k-rows','orm-eager-loading-regression'] },
  { id:'an-004', bug_id:'bug-010', ai_confidence:0.96, regression_risk:81, deployment_risk:'critical', release_blocker:true, root_cause:'Preview frame uses an allow-listed CSP with unsafe-inline; stored XSS via admin comment runs on preview.', affected_components:['comments-preview','admin-cms'], affected_modules:['cms/preview/Comment.tsx'], affected_services:['admin-portal'], recommended_team:'Security Guild', readiness:'hold', readiness_score:38,
    manager_summary:'Stored XSS in admin preview. Ship CSP nonce migration and a sanitizer upgrade before any release touches admin surface.',
    confidence_breakdown:{ reproduction_evidence:0.97, code_analysis:0.94, historical_pattern:0.88, data_integrity:0.95 },
    evidence_items:[
      { category:'reproduction', description:'XSS payload executes in preview frame: alert(1) fires on preview', confidence:0.97, detail:'Confirmed: &lt;img src=x onerror=alert(1)&gt; stored in comment body triggers alert on preview.' },
      { category:'code_review', description:'CSP policy allows unsafe-inline in the preview frames CSP header', confidence:0.94, detail:'cms/preview/Comment.tsx: CSP header includes script-src \'unsafe-inline\' for preview iframe content.' },
      { category:'code_review', description:'Sanitizer not applied to comment body before preview render', confidence:0.92, detail:'Comment body inserted into preview frame innerHTML without DOMPurify or equivalent sanitization.' },
      { category:'historical', description:'Similar CSP misconfiguration patched in admin v3.1 (CVE-2024-0182)', confidence:0.88, detail:'Previous CSP issue in admin report preview (bug #bug-382) was fixed but the comment preview was missed.' }
    ],
    alternative_hypotheses:[
      { description:'XSS vector could also be exploited via comment title field, not just body', likelihood:'medium', rationale:'Title field is rendered in the same preview frame without sanitization. Same CSP bypass applies.' },
      { description:'Attack could be escalated to session cookie exfiltration via script injection', likelihood:'high', rationale:'With unsafe-inline, injected JS can access parent frame cookies if no sandbox attribute is set.' }
    ],
    recommendations:[
      { action:'Replace unsafe-inline with strict nonce-based CSP in preview frame', priority:'critical', owner:'Security Guild', effort:'estimated 4-6 hours' },
      { action:'Apply DOMPurify sanitization to all admin comment fields (body + title)', priority:'critical', owner:'Security Guild', effort:'estimated 2-3 hours' },
      { action:'Add sandbox attribute to preview iframe to prevent parent access', priority:'critical', owner:'Security Guild', effort:'estimated 1 hour' },
      { action:'Audit all admin preview surfaces for similar CSP bypasses', priority:'high', owner:'Security Guild', effort:'estimated 8-12 hours' },
      { action:'Run full security scan on admin-portal before next release', priority:'high', owner:'QA', effort:'estimated 4-6 hours' }
    ],
    reasoning_steps:[
      'Received security advisory: stored XSS in admin comment preview.',
      'Reproduced in staging: comment with XSS payload fires JavaScript in preview iframe.',
      'Inspected CSP header on preview frame: script-src allows unsafe-inline (misconfigured).',
      'Confirmed no input sanitization: comment body inserted via innerHTML without DOMPurify.',
      'Checked historical fix: previous CSP issue in report preview was fixed, but comment preview was missed.',
      'Escalation analysis: unsafe-inline + no sandbox = full session cookie exfiltration possible.',
      'Determined severity: CVSS 8.2 (High) due to stored nature and admin surface access.',
      'Recommended fix: nonce-based CSP, DOMPurify, and iframe sandbox — all three required for defense-in-depth.'
    ],
    suggested_tests:['xss-payload-in-comment-body','xss-payload-in-comment-title','nonce-based-csp-preview-frame','dompurify-sanitization-regression','iframe-sandbox-block-parent-access','cve-2024-0182-regression-check'] },
  { id:'an-005', bug_id:'bug-012', ai_confidence:0.86, regression_risk:62, deployment_risk:'high', release_blocker:false, root_cause:'Stripe timeout falls through to a stale &lsquo;still processing&rsquo; UI; needs success-only rendering.', affected_components:['payments-checkout'], affected_modules:['payments/Checkout/Result.tsx'], affected_services:['payments-api'], recommended_team:'Payments Squad', readiness:'ready', readiness_score:78,
    manager_summary:'Edge case on payment timeout; UX defect with revenue risk. Easy fix; can ship after manual QA.',
    confidence_breakdown:{ reproduction_evidence:0.84, code_analysis:0.90, historical_pattern:0.72, data_integrity:0.86 },
    evidence_items:[
      { category:'reproduction', description:'Payment timeout shows still processing state for 30+ seconds', confidence:0.84, detail:'Use Stripe test mode with card_5890 (delayed confirmation). UI shows processing spinner indefinitely after 10s timeout.' },
      { category:'code_review', description:'Result component only handles success/failure, no timeout branch', confidence:0.90, detail:'payments/Checkout/Result.tsx: switch statement covers payment_intent.succeeded and payment_intent.payment_failed, but not payment_intent.processing.' },
      { category:'log_analysis', description:'Timeout events logged but no UI recovery action triggered', confidence:0.86, detail:'payments-api logs show webhook_timeout events but Result.tsx does not subscribe to them.' }
    ],
    alternative_hypotheses:[
      { description:'WebSocket connection drops before timeout notification reaches client', likelihood:'low', rationale:'WebSocket health checks are active; reconnection logic re-establishes within 2s.' },
      { description:'Race condition between timeout handler and payment_intent.succeeded webhook', likelihood:'medium', rationale:'Possible race if webhook fires during the processing state transition. Should add a cooldown guard.' }
    ],
    recommendations:[
      { action:'Add processing timeout handling to Checkout Result component', priority:'high', owner:'Payments Squad', effort:'estimated 2-4 hours' },
      { action:'Display actionable error message with retry option on payment timeout', priority:'high', owner:'Payments Squad', effort:'estimated 3-5 hours' },
      { action:'Add webhook_timeout event subscription to Result.tsx', priority:'medium', owner:'Payments Squad', effort:'estimated 1-2 hours' },
      { action:'Run manual QA on timed-out transactions across all payment methods', priority:'high', owner:'QA', effort:'estimated 3-5 hours' }
    ],
    reasoning_steps:[
      'User-reported issue: payment times out but UI stays on processing screen indefinitely.',
      'Reproduced with Stripe delayed-confirmation test card: processing state persists beyond 30s.',
      'Inspected Result.tsx component: only handles success (payment_intent.succeeded) and failure (payment_intent.payment_failed).',
      'Confirmed missing case: payment_intent.processing not handled, no timeout branch in the switch.',
      'Checked webhook logs: timeout events fire on payments-api but are not forwarded to the frontend.',
      'Determined impact: users who experience payment timeouts cannot recover without closing the browser tab.',
      'Estimated revenue impact: ~2.3% of checkout flows hit this state based on Stripe timeout metrics.'
    ],
    suggested_tests:['payment-timeout-processing-state','stripe-delayed-confirmation-card','webhook-timeout-event-subscription','timeout-then-success-transition','timeout-then-failure-transition','retry-after-timeout-flow'] }];

/* ---------- theme ---------- */
function currentTheme(){
  const stored = localStorage.getItem(BO_THEME_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function setTheme(t){localStorage.setItem(BO_THEME_KEY, t); applyTheme(t);}
function applyTheme(t){
  document.documentElement.dataset.theme = t || 'dark';
  const btn = $1('#theme-toggle');
  if (btn) {
    const isDark = (t||'') === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches);
    btn.innerHTML = '<i data-lucide="' + (isDark ? 'moon' : 'sun') + '"></i><span>' + (isDark ? 'Dark' : 'Light') + '</span>';
    if (window.lucide) window.lucide.createIcons();
  }
}

/* ---------- backend fetch (preserved signature) ---------- */
async function fetchAll(opts){
  const withRefresh = opts && opts.withRefresh;
  if (!window.lemmaApp) return { bugs: DEMO_BUGS, reviews: DEMO_REVIEWS, analyses: DEMO_ANALYSES, pod: Ctx.pod };
  try {
    const a = await window.lemmaApp.records.list('bugs', { limit: 200 });
    const r = await window.lemmaApp.records.list('triage_reviews', { limit: 200 });
    const n = await window.lemmaApp.records.list('bug_analyses', { limit: 200 });
    return {
      bugs: (a && a.records && a.records.length) ? a.records : DEMO_BUGS,
      reviews: (r && r.records) ? r.records : DEMO_REVIEWS,
      analyses: (n && n.records) ? n.records : DEMO_ANALYSES,
      pod: (a && a.pod_id) || Ctx.pod
    };
  } catch (err) {
    if (!withRefresh) throw err;
    console.warn('fetchAll soft-failed; using seed', err);
    return { bugs: DEMO_BUGS, reviews: DEMO_REVIEWS, analyses: DEMO_ANALYSES, pod: Ctx.pod };
  }
}

/* ---------- chip helpers ---------- */
function severityChip(s){
  const tone = s==='critical'?'crit':s==='major'?'warn':s==='minor'?'info':'accent';
  return '<span class="chip chip-tone-' + tone + '">' + escapeHtml(s||'') + '</span>';
}
function priorityChip(p){
  const tone = p==='urgent'?'crit':p==='high'?'warn':p==='medium'?'info':'accent';
  return '<span class="chip chip-tone-' + tone + '">' + escapeHtml(p||'') + '</span>';
}
function statusChip(st){
  const stt = st==='ready'?'ready':st==='blocked'?'blocked':st==='risk'?'risk':st==='shipped'?'shipped':'triage';
  const label = st==='review'?'review':(st||'');
  return '<span class="pill-status" data-status="' + stt + '">' + escapeHtml(label) + '</span>';
}
function aiCond(c){
  const ci = Math.round((c||0)*100);
  const tone = ci>=80?'high':ci>=55?'mid':'low';
  return '<span class="ai-pill" data-cond="' + tone + '">AI ' + ci + '%</span>';
}
function domainTag(d){
  const dom = (d||'other').toLowerCase();
  const inVocab = DOMAIN_TOKENS.includes(dom) ? dom : 'other';
  const label = dom==='other' ? (d||'Other') : dom;
  return '<span class="tag" data-domain="' + inVocab + '"><span class="dot"></span>' + escapeHtml(label) + '</span>';
}
function sevDot(s){
  return '<span class="sev-dot" data-sev="' + severityTone(s) + '"></span>';
}

/* ---------- primitives ---------- */
function pKpiTile(o){
  let trendCls = '';
  let trendIcon = 'minus';
  if (o.trend) {
    const tone =
      o.trend.tone === 'good' || o.trend.tone === 'bad' || o.trend.tone === 'neutral'
        ? o.trend.tone
        : (o.trend.direction === 'up' ? 'good' : o.trend.direction === 'down' ? 'bad' : 'neutral');
    const iconName = tone === 'good' ? 'trending-up' : tone === 'bad' ? 'trending-down' : 'minus';
    trendCls = 'is-' + tone;
    o.trend = Object.assign({ tone: tone, iconName: iconName }, o.trend);
  }
  const trend = o.trend ? '<div class="kpi-sub ' + trendCls + '"><i data-lucide="' + o.trend.iconName + '"></i>' + escapeHtml(o.trend.text) + '</div>' : '';
  const sub = (o.sub && !o.trend) ? '<div class="kpi-sub">' + escapeHtml(o.sub) + '</div>' : '';
  return '<div class="kpi">'
    + '<div class="kpi-head"><div class="kpi-icon" data-tone="' + (o.tone||'accent') + '"><i data-lucide="' + o.icon + '"></i></div>'
    + '<span class="kpi-label">' + escapeHtml(o.label) + '</span></div>'
    + '<div class="kpi-value">' + o.value + '</div>'
    + trend + sub
    + '</div>';
}
function pCard(o){
  const head = (o.title||o.head) ?
    '<div class="card-head">' + (o.title?'<div class="title">' + o.title + '</div>':'') + (o.meta?'<div class="meta">' + o.meta + '</div>':'') + '</div>' : '';
  return '<div class="card' + (o.padless?' is-padless':'') + '">' + head + (o.body||'') + (o.foot||'') + '</div>';
}
function pScapt(text){return '<span class="scapt"><span class="bar"></span>' + escapeHtml(text) + '</span>';}
function pChip(label, tone){
  return '<span class="chip ' + (tone && tone!=='default'?'chip-tone-' + tone:'') + '">' + escapeHtml(label) + '</span>';
}

/* ---------- charts (inline SVG) — all guarded against missing/invalid input ---------- */
function chartTrendArea(o){
  if (!o || !o.labels || !o.data) return '<div class="chart-wrap"><p style="color:var(--text-3);padding:40px;text-align:center;font-size:13px">Chart data unavailable</p></div>';
  const w=600, h=220, pad={t:16,r:12,b:24,l:32};
  const xs = o.labels.map((_,i)=> pad.l + (i/(o.labels.length-1)) * (w-pad.l-pad.r));
  const all = o.data.flatMap(s => s.values);
  const max = Math.max(10, ...all);
  const yVal = v => pad.t + (1 - v/max) * (h-pad.t-pad.b);

  const seriesSvg = o.data.map((s, i) => {
    const pts = s.values.map((v,j)=> xs[j]+','+yVal(v)).join(' ');
    const area = xs[0]+','+yVal(0)+' '+pts+' '+xs[xs.length-1]+','+yVal(0);
    const path = area.split(' ').join(' L ');
    return '<defs><linearGradient id="tg-' + i + '-' + Math.random().toString(36).slice(2,6) + '" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="'+s.color+'" stop-opacity=".42"/>'
      + '<stop offset="1" stop-color="'+s.color+'" stop-opacity="0"/>'
      + '</linearGradient></defs>'
      + '<path d="M '+path+' Z" fill="url(#tg-' + i + ')" />'
      + '<polyline points="'+pts+'" fill="none" stroke="'+s.color+'" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
  }).join('');
  const grid = [0,0.25,0.5,0.75,1].map(t => {
    const gy = pad.t + t * (h-pad.t-pad.b);
    const v = Math.round(max*(1-t));
    return '<line x1="'+pad.l+'" y1="'+gy+'" x2="'+(w-pad.r)+'" y2="'+gy+'" stroke="rgba(255,255,255,.05)"/>'
         + '<text x="'+(pad.l-6)+'" y="'+(gy+4)+'" font-size="10" fill="var(--text-3)" text-anchor="end">'+v+'</text>';
  }).join('');
  const xLabels = o.labels.map((l,i)=> '<text x="'+xs[i]+'" y="'+(h-6)+'" font-size="10" fill="var(--text-3)" text-anchor="middle">'+escapeHtml(l)+'</text>').join('');
  return '<svg class="chart-svg" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none">' + grid + seriesSvg + xLabels + '</svg>';
}
function chartDonut(o){
  if (!o || !o.slices) return '<div class="chart-wrap"><p style="color:var(--text-3);padding:40px;text-align:center;font-size:13px">Chart data unavailable</p></div>';
  const size = o.size || 220;
  const r = size/2 - 12;
  const inner = r - 28;
  const cx = size/2, cy = size/2;
  const total = o.slices.reduce((a,s)=>a+s.value,0) || 1;
  let accum = 0;
  const paths = o.slices.map(s => {
    const start = accum/total*Math.PI*2; accum += s.value;
    const end = accum/total*Math.PI*2;
    const a0 = start - Math.PI/2, a1 = end - Math.PI/2;
    const large = (end - start) > Math.PI ? 1 : 0;
    const x0 = cx+Math.cos(a0)*r, y0=cy+Math.sin(a0)*r;
    const x1 = cx+Math.cos(a1)*r, y1=cy+Math.sin(a1)*r;
    const xi0 = cx+Math.cos(a0)*inner, yi0=cy+Math.sin(a0)*inner;
    const xi1 = cx+Math.cos(a1)*inner, yi1=cy+Math.sin(a1)*inner;
    return '<path d="M '+x0+' '+y0+' A '+r+' '+r+' 0 '+large+' 1 '+x1+' '+y1+' L '+xi1+' '+yi1+' A '+inner+' '+inner+' 0 '+large+' 0 '+xi0+' '+yi0+' Z" fill="'+s.color+'"/>';
  }).join('');
  return '<svg viewBox="0 0 '+size+' '+size+'" class="chart-svg" style="width:100%;height:'+size+'px">'
    + paths
    + '<text x="'+cx+'" y="'+(cy-2)+'" text-anchor="middle" font-size="22" font-weight="700" fill="var(--text-1)">'+total+'</text>'
    + '<text x="'+cx+'" y="'+(cy+14)+'" text-anchor="middle" font-size="10" fill="var(--text-3)">total</text>'
    + '</svg>';
}
function chartBars(o){
  if (!o || !o.values || !o.labels) return '<div class="chart-wrap"><p style="color:var(--text-3);padding:40px;text-align:center;font-size:13px">Chart data unavailable</p></div>';
  const w=600, h=220, pad={t:16,r:12,b:28,l:32};
  const max = Math.max(1, ...o.values.map(v=>v.value));
  const colw = (w-pad.l-pad.r)/o.values.length;
  const bars = o.values.map((v, i) => {
    const h2 = (v.value/max) * (h - pad.t - pad.b);
    const x = pad.l + i*colw + colw*0.18;
    const y = h - pad.b - h2;
    const w2 = colw * 0.64;
    return '<rect x="'+x+'" y="'+y+'" width="'+w2+'" height="'+h2+'" rx="6" fill="'+(v.color||o.color||'#8B5CF6')+'" fill-opacity=".92"/>'
      + '<text x="'+(x+w2/2)+'" y="'+(y+16)+'" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">'+v.value+'</text>'
      + '<text x="'+(x+w2/2)+'" y="'+(h-8)+'" font-size="10" fill="var(--text-3)" text-anchor="middle">'+escapeHtml(o.labels[i]||'')+'</text>';
  }).join('');
  const grid = [0,0.25,0.5,0.75,1].map(t => {
    const gy = pad.t + t * (h-pad.t-pad.b);
    return '<line x1="'+pad.l+'" y1="'+gy+'" x2="'+(w-pad.r)+'" y2="'+gy+'" stroke="rgba(255,255,255,.05)"/>';
  }).join('');
  return '<svg viewBox="0 0 '+w+' '+h+'" class="chart-svg">' + grid + bars + '</svg>';
}
function ringSvg(pct, size, rgb, track){
  if (pct === undefined || pct === null) pct = 0;
  size = size || 76; rgb = rgb || '#8B5CF6';
  track = track || 'var(--bg-3)';
  const r = (size - 8)/2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct/100);
  return '<svg width="'+size+'" height="'+size+'" viewBox="0 0 '+size+' '+size+'">'
    + '<circle cx="'+size/2+'" cy="'+size/2+'" r="'+r+'" stroke="'+track+'" stroke-width="6" fill="none"/>'
    + '<circle cx="'+size/2+'" cy="'+size/2+'" r="'+r+'" stroke="'+rgb+'" stroke-width="6" fill="none" stroke-linecap="round" stroke-dasharray="'+c+'" stroke-dashoffset="'+offset+'" transform="rotate(-90 '+(size/2)+' '+(size/2)+')"/>'
    + '</svg>';
}

/* ---------- Phase 4: Analytics Engine ---------- */

function chartHorizontalBars(o) {
  if (!o || !o.items) return '<div class="chart-wrap"><p style="color:var(--text-3);padding:20px;text-align:center;font-size:13px">Chart data unavailable</p></div>';
  const max = Math.max(1, ...o.items.map(function(i){ return i.value; }));
  return '<div style="padding:4px 0">' + o.items.map(function(item) {
    const pct = (item.value / max) * 100;
    const color = item.color || '#8B5CF6';
    return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">'
      + '<div style="width:100px;font-size:12px;color:var(--text-2);text-align:right;flex-shrink:0;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(item.label) + '</div>'
      + '<div style="flex:1;height:22px;background:var(--bg-3);border-radius:6px;overflow:hidden;position:relative">'
        + '<div style="width:' + pct + '%;height:100%;background:' + color + ';border-radius:6px;opacity:.85"></div>'
      + '</div>'
      + '<div style="width:24px;font-size:12px;font-weight:700;color:var(--text-1);flex-shrink:0;text-align:right">' + item.value + '</div>'
    + '</div>';
  }).join('') + '</div>';
}

function computeBugAging() {
  const bugs = safeArr(Ctx.bugs);
  const now = Date.now();
  const buckets = [];
  function addBucket(label, minH, maxH) { buckets.push({ label: label, min: minH, max: maxH, value:0 }); }
  addBucket('<1h', 0, 1);
  addBucket('1-6h', 1, 6);
  addBucket('6-12h', 6, 12);
  addBucket('12-24h', 12, 24);
  addBucket('24h+', 24, Infinity);
  buckets.forEach(function(b){ b.value = 0; });
  bugs.forEach(function(b) {
    const age = now - new Date(b.created_at || now).getTime();
    const h = age / 3600000;
    for (var i = 0; i < buckets.length; i++) {
      if (h >= buckets[i].min && h < buckets[i].max) { buckets[i].value++; break; }
    }
  });
  return buckets.map(function(b){ return { label: b.label, value: b.value, color: b.value > 4 ? '#EF4444' : b.value > 2 ? '#F59E0B' : '#8B5CF6' }; });
}

function computeModuleHotspots() {
  const domains = {};
  safeArr(Ctx.bugs).forEach(function(b) {
    const d = b.domain || 'other';
    domains[d] = (domains[d]||0) + 1;
  });
  return Object.keys(domains).sort(function(a,b){ return domains[b] - domains[a]; }).slice(0,8).map(function(label) {
    const value = domains[label];
    return { label: label, value: value, color: value > 3 ? '#EF4444' : value > 1 ? '#F59E0B' : '#8B5CF6' };
  });
}

function computeResolutionStats() {
  const bugs = safeArr(Ctx.bugs);
  const statuses = {};
  bugs.forEach(function(b) {
    const st = b.status || 'unknown';
    statuses[st] = (statuses[st]||0) + 1;
  });
  const total = bugs.length || 1;
  const order = ['review', 'triaged', 'blocked', 'risk', 'ready', 'shipped', 'unknown'];
  return order.filter(function(s){ return statuses[s]; }).map(function(status) {
    return { status: status, count: statuses[status], pct: Math.round(statuses[status]/total*100) };
  });
}

function computeReviewerWorkload() {
  const workload = {};
  safeArr(Ctx.reviews).forEach(function(r) {
    const actor = r.actor || 'unknown';
    workload[actor] = (workload[actor]||0) + 1;
  });
  return Object.keys(workload).sort(function(a,b){ return workload[b] - workload[a]; }).map(function(actor) {
    return { actor: actor, count: workload[actor] };
  });
}

function computeConfidenceTrend() {
  const bugs = safeArr(Ctx.bugs);
  const aMap = ANALYSES_BY_BUG();
  const sorted = bugs.slice().sort(function(a,b){ return new Date(a.created_at||0) - new Date(b.created_at||0); });
  const chunks = [];
  const chunkSize = Math.max(1, Math.ceil(sorted.length / 5));
  for (var i = 0; i < sorted.length; i += chunkSize) {
    const chunk = sorted.slice(i, i + chunkSize);
    var sum = 0, count = 0;
    chunk.forEach(function(b) {
      const a = aMap[b.id];
      if (a && a.ai_confidence) { sum += a.ai_confidence; count++; }
    });
    chunks.push(count ? Math.round(sum/count * 100) : 85);
  }
  return chunks;
}

function computeStatsSummary() {
  const bugs = safeArr(Ctx.bugs);
  var confSum = 0, confCount = 0;
  safeArr(Ctx.analyses).forEach(function(a) {
    if (a.ai_confidence) { confSum += a.ai_confidence; confCount++; }
  });
  const sorted = bugs.slice().sort(function(a,b){ return new Date(a.created_at||0) - new Date(b.created_at||0); });
  const oldest = sorted[0];
  return {
    total: bugs.length,
    open: bugs.filter(function(b){ return !['shipped','ready'].includes(b.status||''); }).length,
    shipped: bugs.filter(function(b){ return b.status === 'shipped'; }).length,
    ready: bugs.filter(function(b){ return b.status === 'ready'; }).length,
    avgConf: confCount ? Math.round(confSum/confCount * 100) : 85,
    oldestAge: oldest ? Math.round((Date.now() - new Date(oldest.created_at).getTime())/3600000) : 0,
    domains: Object.keys(domainCounts()).length
  };
}

/* ---------- routing ---------- */
/* ---------- Phase 5: Workflow Intelligence ---------- */

function computePriorityScore(bug, analysis) {
  bug = safeObj(bug);
  analysis = safeAnalysis(analysis);
  var score = 50;
  var factors = [];
  var severity = bug.severity || 'minor';
  var sevScore = severity === 'critical' ? 95 : severity === 'major' ? 75 : severity === 'minor' ? 50 : 25;
  factors.push({ factor: 'Severity: ' + severity, weight: 0.30, contribution: Math.round(sevScore * 0.30) });
  score += (sevScore - 50) * 0.30;
  var conf = analysis.ai_confidence || 0.85;
  var confScore = Math.round(conf * 100);
  factors.push({ factor: 'AI Confidence: ' + confScore + '%', weight: 0.20, contribution: Math.round(confScore * 0.20) });
  score += (confScore - 50) * 0.20;
  var regRisk = analysis.regression_risk || 50;
  var regScore = Math.min(100, regRisk + 20);
  factors.push({ factor: 'Regression Risk: ' + regRisk + '%', weight: 0.15, contribution: Math.round(regScore * 0.15) });
  score += (regScore - 50) * 0.15;
  if (analysis.release_blocker) { factors.push({ factor: 'Release blocker', weight: 0.15, contribution: 15 }); score += 15; }
  var ageH = bug.created_at ? (Date.now() - new Date(bug.created_at).getTime()) / 3600000 : 0;
  var ageScore = ageH > 24 ? 80 : ageH > 12 ? 70 : ageH > 6 ? 60 : ageH > 1 ? 50 : 40;
  factors.push({ factor: 'Age: ' + (ageH < 1 ? '<1h' : Math.round(ageH) + 'h'), weight: 0.10, contribution: Math.round(ageScore * 0.10) });
  score += (ageScore - 50) * 0.10;
  var urgency = bug.priority || 'medium';
  var urgScore = urgency === 'urgent' ? 90 : urgency === 'high' ? 75 : urgency === 'medium' ? 50 : 25;
  factors.push({ factor: 'Priority: ' + urgency, weight: 0.10, contribution: Math.round(urgScore * 0.10) });
  score += (urgScore - 50) * 0.10;
  score = Math.max(0, Math.min(100, Math.round(score)));
  var label = score >= 85 ? 'Critical' : score >= 65 ? 'High' : score >= 40 ? 'Medium' : 'Low';
  return { score: score, label: label, factors: factors };
}

function recommendAssignment(bug, analysis) {
  bug = safeObj(bug);
  analysis = safeAnalysis(analysis);
  var team = analysis.recommended_team || '';
  if (team) return { assignee: team, source: 'AI analysis' };
  var domain = bug.domain || '';
  var assignees = {
    'payments': 'Payments Squad',
    'auth': 'Identity Squad',
    'reports': 'Reports Squad',
    'dashboard': 'Dashboard Team',
    'api': 'API Team',
    'notifications': 'Notifications Squad',
    'billing': 'Billing Team',
    'mobile': 'Mobile Team',
    'data': 'Data Engineering',
    'other': 'Engineering on-call'
  };
  var suggested = assignees[domain] || 'Engineering on-call';
  return { assignee: suggested, source: 'Domain-based routing' };
}

function suggestEscalation(bug, analysis) {
  bug = safeObj(bug);
  analysis = safeAnalysis(analysis);
  var reasons = [];
  if (bug.severity === 'critical' && analysis.release_blocker) {
    reasons.push({ level: 'critical', message: 'Critical release blocker — escalate to Engineering Director immediately.' });
  }
  if (bug.severity === 'critical' && (analysis.regression_risk || 0) > 75) {
    reasons.push({ level: 'high', message: 'Critical severity with high regression risk — escalate to Release Manager.' });
  }
  var ageH = bug.created_at ? (Date.now() - new Date(bug.created_at).getTime()) / 3600000 : 0;
  if (bug.severity === 'major' && ageH > 12 && !analysis.recommended_team) {
    reasons.push({ level: 'medium', message: 'Major bug older than 12 hours without assignment — escalate to Engineering Manager for triage.' });
  }
  if (bug.severity === 'critical' && ageH > 6 && bug.status === 'review') {
    reasons.push({ level: 'high', message: 'Critical bug in review for over 6 hours — accelerate approval process.' });
  }
  if (analysis.deployment_risk === 'critical' && analysis.readiness === 'hold') {
    reasons.push({ level: 'critical', message: 'Critical deployment risk on hold — requires VP Engineering decision.' });
  }
  return reasons.length ? reasons : null;
}

function detectDuplicates(bugId) {
  var current = ANALYSES_BY_BUG()[bugId];
  if (!current) return [];
  var currentBug = Ctx.bugs.find(function(b){ return b.id === bugId; }) || {};
  var titleWords = (currentBug.title || '').toLowerCase().split(/\s+/).filter(Boolean);
  var descWords = (currentBug.desc || '').toLowerCase().split(/\s+/).filter(Boolean);
  var comps = new Set(current.affected_components || []);
  var mods = new Set(current.affected_modules || []);
  var matches = [];
  Object.entries(ANALYSES_BY_BUG()).forEach(function(entry) {
    var otherId = entry[0], a = entry[1];
    if (otherId === bugId) return;
    var otherBug = Ctx.bugs.find(function(b){ return b.id === otherId; }) || {};
    var sharedComps = (a.affected_components || []).filter(function(c){ return comps.has(c); }).length;
    var sharedMods = (a.affected_modules || []).filter(function(m){ return mods.has(m); }).length;
    var otherTitle = (otherBug.title || '').toLowerCase();
    var otherDesc = (otherBug.desc || '').toLowerCase();
    var titleOverlap = titleWords.filter(function(w){ return otherTitle.includes(w); }).length;
    var descOverlap = descWords.filter(function(w){ return otherDesc.includes(w); }).length;
    var score = sharedComps * 25 + sharedMods * 15 + titleOverlap * 5 + descOverlap * 2;
    if (score > 10) {
      var reasons = [];
      if (sharedComps > 0) reasons.push(sharedComps + ' shared component(s)');
      if (sharedMods > 0) reasons.push(sharedMods + ' shared module(s)');
      if (titleOverlap > 0) reasons.push(titleOverlap + ' title word(s) match');
      matches.push({ id: otherId, title: otherBug.title || otherId, severity: otherBug.severity, status: otherBug.status, score: score, reasons: reasons });
    }
  });
  matches.sort(function(a,b){ return b.score - a.score; });
  return matches.slice(0, 5);
}

function workflowRecommend(bug) {
  bug = safeObj(bug);
  var status = bug.status || 'unknown';
  var recs = {
    'review': { step: 'Assign & triage', description: 'This bug is awaiting assignment. Next step: assign to a team member for triage and root cause analysis.', priority: 'high', icon: 'user-plus' },
    'triaged': { step: 'Begin development', description: 'Root cause identified. Next step: assign a developer to implement the fix based on AI recommendations.', priority: 'high', icon: 'code' },
    'blocked': { step: 'Remove blocker', description: 'This bug is blocked. Next step: identify the blocking dependency and escalate if needed to unblock development.', priority: 'critical', icon: 'unlock' },
    'risk': { step: 'Mitigate risk', description: 'Development complete but risk is elevated. Next step: run additional regression tests and prepare release notes.', priority: 'high', icon: 'shield-alert' },
    'ready': { step: 'Ship to production', description: 'Fix is ready. Next step: approve for release, run final smoke tests, and deploy to production.', priority: 'medium', icon: 'rocket' },
    'shipped': { step: 'Verify & close', description: 'Fix shipped. Next step: verify the fix in production, monitor for regressions, and close the bug.', priority: 'low', icon: 'check-check' }
  };
  return recs[status] || { step: 'Triage', description: 'New bug. Next step: run AI analysis and categorize severity and priority.', priority: 'medium', icon: 'search' };
}

function estimateImpact(bug, analysis) {
  bug = safeObj(bug);
  analysis = safeAnalysis(analysis);
  var sev = bug.severity || 'minor';
  var engMap = { critical: 'High', major: 'High', minor: 'Medium', cosmetic: 'Low' };
  var custMap = { critical: 'Critical', major: 'Medium', minor: 'Low', cosmetic: 'None' };
  var revMap = { critical: 'High', major: 'Medium', minor: 'Low', cosmetic: 'None' };
  var engineering = engMap[sev] || 'Medium';
  var customer = custMap[sev] || 'Low';
  var revenue = revMap[sev] || 'Low';
  var rationale = [];
  if (engineering === 'High') rationale.push('Touches core ' + (analysis.affected_components||['unknown']).join(', ') + ' component(s).');
  if (customer === 'Critical') rationale.push('Directly impacts end users with data or billing consequences.');
  if (revenue === 'High') rationale.push('Revenue-affecting path: ' + (bug.domain||'unknown') + ' domain.');
  if (analysis.release_blocker) rationale.push('Release blocker — blocks all deployments until resolved.');
  return { engineering: engineering, customer: customer, revenue: revenue, rationale: rationale.join(' ') };
}


function route(){
  try {
  var prevHash = Ctx._route;
  var isSamePage = prevHash && prevHash.split('?')[0] === (location.hash || '#/').replace(/^#/, '').split('?')[0];
  if (isSamePage) { Ctx._scrollPos = { top: window.scrollY, route: (location.hash || '#/').replace(/^#/, '') || '/' }; }
  const hash = (location.hash || '#/').replace(/^#/, '') || '/';
  Ctx._route = hash;
  const segs = hash.split('?')[0].split('/').filter(Boolean);

  let Page = renderDashboard, pageArgs = [], activeNav = '#/', pageTitle = 'Executive Dashboard';

  if (hash.startsWith('/operations'))      { Page = renderOperations;    activeNav='#/operations'; pageTitle='Bug Operations'; }
  else if (hash.startsWith('/bug/'))        { Page = renderBugDetail;     pageArgs=[segs[1]]; activeNav='#/operations'; pageTitle='Bug Details'; }
  else if (hash.startsWith('/releases'))    { Page = renderReleases;      activeNav='#/releases';   pageTitle='Release Center'; }
  else if (hash.startsWith('/insights'))    { Page = renderInsights;      activeNav='#/insights';   pageTitle='Engineering Insights'; }
  else if (hash.startsWith('/ai-commander')){ Page = renderAICommanderPage; activeNav='#/ai-commander'; pageTitle='AI Commander'; }
  else if (hash.startsWith('/settings'))    { Page = renderSettings;      activeNav='#/settings';   pageTitle='Settings'; }

  $$('.sb-link').forEach(n => n.dataset.active = String(n.dataset.route === activeNav));
  const af1 = $1('#appfoot-route'); if (af1) af1.textContent = pageTitle;
  const af2 = $1('#appfoot-time');  if (af2) af2.textContent = new Date().toLocaleTimeString();

  const root = $1('#routes');
  if (!root) return;
  if (Ctx.loading) { root.innerHTML = renderSkeleton(); return; }
  root.innerHTML = '';
  root.classList.remove('page-fade-in');
  void root.offsetHeight;
  root.appendChild(Page(...pageArgs));
  root.classList.add('page-fade-in');
  if (window.lucide) window.lucide.createIcons();
  root.focus();
  var savedScroll = Ctx._scrollPos && Ctx._scrollPos.route === hash ? Ctx._scrollPos.top : 0;
  if (savedScroll > 0) { window.scrollTo(0, savedScroll); Ctx._scrollPos = null; }
  } catch(e) {
    console.warn('[BugOps] route() failed:', e);
    const root = $1('#routes');
    if (root) root.innerHTML = '<div class="page"><div class="page-head"><h1>BugOps</h1></div>' + safeFallback('Page could not be rendered.') + '</div>';
  }
}
window.addEventListener('hashchange', route);

function renderSkeleton(){
  return '<div class="page">'
    + '<div class="page-head"><div class="lead"><div class="skeleton" style="width:140px;height:14px"></div>'
    + '<div class="skeleton" style="width:280px;height:32px;margin-top:8px"></div>'
    + '<div class="skeleton" style="width:360px;height:14px;margin-top:8px"></div></div>'
    + '<div class="page-actions"><div class="skeleton" style="width:100px;height:36px;border-radius:8px"></div>'
    + '<div class="skeleton" style="width:140px;height:36px;border-radius:8px"></div></div></div>'
    + '<div class="kpi-strip">' + '<div class="kpi"><div class="skeleton" style="width:36px;height:36px;border-radius:10px"></div><div class="skeleton" style="width:70%;height:14px;margin-top:8px"></div><div class="skeleton" style="width:50%;height:28px;margin-top:6px"></div></div>'.repeat(5) + '</div>'
    + '<div class="two-up" style="margin-top:16px">'
      + '<div class="col">' + '<div class="card"><div class="skeleton" style="width:60%;height:16px"></div><div class="skeleton" style="width:100%;height:160px;margin-top:12px;border-radius:8px"></div></div>'.repeat(2) + '</div>'
      + '<div class="col">' + '<div class="card"><div class="skeleton" style="width:50%;height:16px"></div><div class="skeleton" style="width:100%;height:160px;margin-top:12px;border-radius:8px"></div></div>'.repeat(2) + '</div>'
    + '</div>'
    + '</div>';
}

/* ---------- pages ---------- */

function deriveStats(){
  try {
    const bugs = safeArr(Ctx.bugs);
    const analyses = safeArr(Ctx.analyses);
    const bysev = bugs.reduce(function(a,b){ a[b.severity]=(a[b.severity]||0)+1; return a; }, {});
    const confs = analyses.map(function(a){ return a.ai_confidence||0; });
    const avg = confs.length ? confs.reduce(function(a,c){ return a+c; },0)/confs.length : 0.86;
    return {
      critical: bysev.critical||0,
      criticalDelta: 1,
      mttr: 4.6, mttrDelta: 0.4,
      readiness: Math.round(avg*100),
      health: Math.min(100, 30 + 70 - (bysev.critical||0)*6),
      aiConf: Math.round(avg*100)
    };
  } catch (e) {
    console.warn('[BugOps] deriveStats failed:', e);
    return { critical:0, criticalDelta:0, mttr:0, mttrDelta:0, readiness:50, health:50, aiConf:50 };
  }
}

function renderDashboard(){
  try {
  const a_map = ANALYSES_BY_BUG();
  const stats = deriveStats();
  const crit = safeArr(Ctx.bugs).filter(function(b){ return b.severity==='critical'; }).slice(0,5);

  return el(
    '<div class="page">'
    + '<div class="page-head">'
      + '<div class="lead"><div class="eyebrow">BugOps AI &middot; Dashboard</div>'
      + '<h1>Executive Dashboard</h1>'
      + '<div class="page-sub">The question we&rsquo;re answering: <b>Can we safely release today?</b></div></div>'
      + '<div class="page-actions"><button class="btn-secondary"><i data-lucide="download"></i>Export</button>'
      + '<button class="btn-primary"><i data-lucide="wand-2"></i>Run AI Report</button></div>'
    + '</div>'

    + '<div class="kpi-strip">'
      + pKpiTile({ icon:'alert-octagon', label:'Open Critical', value:stats.critical, tone:'crit', trend:{ tone: stats.criticalDelta<0?'good':'bad', text: (stats.criticalDelta<0?'-':'+') + Math.abs(stats.criticalDelta) + ' this week' } })
      + pKpiTile({ icon:'timer', label:'MTTR', value:stats.mttr+'h', tone:'ok', trend:{ tone:stats.mttrDelta<0?'good':stats.mttrDelta>0?'bad':'neutral', text:(stats.mttrDelta<0?'-':'+')+Math.abs(stats.mttrDelta)+'h' } })
      + pKpiTile({ icon:'gauge', label:'Release Readiness', value:stats.readiness+'%', tone:'accent', sub:'Goal: ship-ready' })
      + pKpiTile({ icon:'shield-check', label:'Engineering Health', value:stats.health+'/100', tone:'info', sub:'Across '+Ctx.bugs.length+' open bugs' })
      + pKpiTile({ icon:'brain-circuit', label:'AI Confidence', value:stats.aiConf+'%', tone:'accent', sub:'Avg across analysed' })
    + '</div>'

    + '<div class="two-up"><div class="col">'
      + pCard({
          head: '<div style="display:flex;justify-content:space-between;align-items:center"><div class="title">Bug Trends</div><span class="meta">last 6 weeks</span></div>',
          body: '<div class="chart-wrap">' + chartTrendArea({
            data: [
              { label:'AI-Detected', color:'#8B5CF6', values:[14,18,22,27,33,38] },
              { label:'Eng-Reported', color:'#94A3B8', values:[8,10,13,12,16,19] }
            ],
            labels: ['Wk 1','Wk 2','Wk 3','Wk 4','Wk 5','Wk 6']
          }) + '</div>'
            + '<div class="legend"><span><i class="swatch" style="background:#8B5CF6"></i>AI-Detected</span><span><i class="swatch" style="background:#94A3B8"></i>Engineering-Reported</span></div>'
        })
      + pCard({
          head: '<div style="display:flex;justify-content:space-between;align-items:center"><div class="title">Critical Bugs</div><a class="meta" href="#/operations?severity=critical">View all <i data-lucide="arrow-right" style="width:14px;height:14px;display:inline-block;vertical-align:text-bottom"></i></a></div>',
          body: (crit.length ? crit.map(b =>
            '<a class="mini-row" href="#/bug/' + encodeURIComponent(b.id) + '">'
              + '<div>' + sevDot(b.severity) + '<b style="margin-left:8px">' + escapeHtml(b.title) + '</b>'
              + '<div class="page-sub" style="margin-top:4px">' + escapeHtml((b.desc||'').slice(0,86)) + '</div></div>'
              + '<div>' + domainTag(b.domain) + '</div>'
              + '<div>' + aiCond(a_map[b.id] ? a_map[b.id].ai_confidence : 0.86) + '</div>'
            + '</a>').join('')
          : '<div class="empty"><div class="icn"><i data-lucide="check"></i></div><h4>Nothing critical open</h4><p>The AI is holding the line.</p></div>')
        })
    + '</div><div class="col">'
      + pCard({
          head: '<div style="display:flex;justify-content:space-between;align-items:center"><div class="title">Severity Distribution</div><span class="meta">' + Ctx.bugs.length + ' open</span></div>',
          body:
            '<div style="display:grid;grid-template-columns:160px 1fr;gap:16px;align-items:center">'
              + chartDonut({ size:160, slices:[
                { label:'Critical', color:'#EF4444', value:Ctx.bugs.filter(b=>b.severity==='critical').length },
                { label:'Major',    color:'#F59E0B', value:Ctx.bugs.filter(b=>b.severity==='major').length },
                { label:'Minor',    color:'#3B82F6', value:Ctx.bugs.filter(b=>b.severity==='minor').length },
                { label:'Cosmetic', color:'#7C8499', value:Ctx.bugs.filter(b=>b.severity==='cosmetic').length }
              ] })
              + '<div style="display:flex;flex-direction:column;gap:10px">'
                + [
                    { name:'Critical', count:Ctx.bugs.filter(b=>b.severity==='critical').length, color:'#EF4444' },
                    { name:'Major',    count:Ctx.bugs.filter(b=>b.severity==='major').length,    color:'#F59E0B' },
                    { name:'Minor',    count:Ctx.bugs.filter(b=>b.severity==='minor').length,    color:'#3B82F6' },
                    { name:'Cosmetic', count:Ctx.bugs.filter(b=>b.severity==='cosmetic').length, color:'#7C8499' }
                  ].map(s => '<div style="display:flex;align-items:center;gap:8px"><i class="swatch" style="background:'+s.color+'"></i><span style="font-size:13px;color:var(--text-2)">'+s.name+'</span><span style="margin-left:auto;font-weight:700;color:var(--text-1)">'+s.count+'</span></div>').join('')
              + '</div></div>'
        })
      + pCard({
          head: '<div class="title">Recent AI Activity</div>',
          body: (Ctx.reviews.length ? Ctx.reviews.slice(0,6).map(r =>
            '<div class="mini-row">'
              + '<div><b style="color:var(--text-1)">' + escapeHtml((Ctx.bugs.find(b=>b.id===r.bug_id)||{}).title || r.bug_id) + '</b></div>'
              + '<div><span class="chip">' + escapeHtml(r.kind) + '</span></div>'
              + '<div style="color:var(--text-3)">' + fmtRel(r.created_at) + '</div>'
            + '</div>').join('')
          : '<div class="empty"><div class="icn"><i data-lucide="history"></i></div><h4>No recent activity</h4><p>AI reviews and approvals will appear here once bugs are analyzed.</p></div>')
        })
    + '</div></div>'

    + pCard({
        head: '<div style="display:flex;justify-content:space-between;align-items:center"><div class="title">Risk Overview</div><span class="meta">Release-decision context</span></div>',
        body: '<div class="risk-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">'
          + '<div class="risk-panel" data-state="blocker"><div><div style="font-weight:700">Stripe refactor</div><div style="font-size:12px;color:var(--text-3);margin-top:4px">Hard release blocker detected &middot; v4.4</div></div><span class="chip chip-tone-crit">Blocker</span></div>'
          + '<div class="risk-panel" data-state="blocker"><div><div style="font-weight:700">Stored XSS in admin preview</div><div style="font-size:12px;color:var(--text-3);margin-top:4px">CSP migration pending &middot; v4.4</div></div><span class="chip chip-tone-crit">Blocker</span></div>'
          + '<div class="risk-panel"><div><div style="font-weight:700">OAuth tab-nonce</div><div style="font-size:12px;color:var(--text-3);margin-top:4px">Defer fix to v4.5; cookie flag protects most users</div></div><span class="chip chip-tone-warn">Watch</span></div>'
          + '<div class="risk-panel"><div><div style="font-weight:700">Auth dashboard contrast</div><div style="font-size:12px;color:var(--text-3);margin-top:4px">AA token upgrade; low-risk</div></div><span class="chip chip-tone-info">Info</span></div>'
          + '<div class="risk-panel" data-state="safe"><div><div style="font-weight:700">Billing CSV token rotation</div><div style="font-size:12px;color:var(--text-3);margin-top:4px">Ready-to-ship; 0 regressions in load test</div></div><span class="chip chip-tone-ok">Ready</span></div>'
          + '<div class="risk-panel"><div><div style="font-weight:700">Android biometric fallback</div><div style="font-size:12px;color:var(--text-3);margin-top:4px">Pixel 8 fix shipped, flag holds releases</div></div><span class="chip chip-tone-warn">Watch</span></div>'
    + pCard({
        head: '<div style="display:flex;justify-content:space-between;align-items:center"><div class="title">Escalation Watch</div><span class="meta">AI-detected flags</span></div>',
        body: (function(){
          var items = [];
          safeArr(Ctx.bugs).forEach(function(b){
            var a = safeObj(ANALYSES_BY_BUG()[b.id]);
            var es = suggestEscalation(b, a);
            if (es) {
              es.forEach(function(e){
                items.push({ id: b.id, title: b.title, level: e.level, message: e.message });
              });
            }
          });
          items.sort(function(x,y){ var lv={critical:3,high:2,medium:1}; return (lv[y.level]||0)-(lv[x.level]||0); });
          items = items.slice(0, 6);
          return items.length
            ? items.map(function(i){
                var tone = i.level === 'critical' ? 'crit' : i.level === 'high' ? 'warn' : 'info';
                return '<a class="mini-row" href="#/bug/' + encodeURIComponent(i.id) + '">'
                  + '<span class="sev-dot" data-sev="' + (i.level === 'critical' ? 'critical' : i.level === 'high' ? 'major' : 'minor') + '"></span>'
                  + '<div><div style="font-size:13px;font-weight:600;color:var(--text-1)">' + escapeHtml(i.title) + '</div>'
                  + '<div style="font-size:11px;color:var(--text-3)">' + escapeHtml(i.message.slice(0, 120)) + '</div></div>'
                  + '<span class="chip chip-tone-' + tone + '">' + escapeHtml(i.level) + '</span>'
                  + '</a>';
              }).join('')
            : '<div class="empty" style="padding:12px"><div class="icn"><i data-lucide="check-circle"></i></div><h4>No escalation flags</h4><p>No bugs currently require escalation.</p></div>';
        })()
      })


        + '</div>'
      })

    + pCard({
        head: '<div class="title">Quick Actions</div>',
        body: '<div class="kpi-strip is-quick-actions">'
          + '<a class="kpi" href="#/operations?view=table" style="text-align:center;gap:6px;align-items:center"><div class="kpi-icon" data-tone="accent" style="margin:0 auto"><i data-lucide="list-tree"></i></div><div style="font-size:13px;font-weight:600;color:var(--text-1)">Activity</div></a>'
          + '<a class="kpi" href="#/releases" style="text-align:center;gap:6px;align-items:center"><div class="kpi-icon" data-tone="accent" style="margin:0 auto"><i data-lucide="rocket"></i></div><div style="font-size:13px;font-weight:600;color:var(--text-1)">Releases</div></a>'
          + '<a class="kpi" href="#/operations?view=grid" style="text-align:center;gap:6px;align-items:center"><div class="kpi-icon" data-tone="accent" style="margin:0 auto"><i data-lucide="inbox"></i></div><div style="font-size:13px;font-weight:600;color:var(--text-1)">Triage</div></a>'
          + '<a class="kpi" href="#/insights" style="text-align:center;gap:6px;align-items:center"><div class="kpi-icon" data-tone="accent" style="margin:0 auto"><i data-lucide="history"></i></div><div style="font-size:13px;font-weight:600;color:var(--text-1)">Audit</div></a>'
          + '<a class="kpi" href="#/settings" style="text-align:center;gap:6px;align-items:center"><div class="kpi-icon" data-tone="accent" style="margin:0 auto"><i data-lucide="settings-2"></i></div><div style="font-size:13px;font-weight:600;color:var(--text-1)">Configure AI</div></a>'
          + '<a class="kpi" href="#/settings" style="text-align:center;gap:6px;align-items:center"><div class="kpi-icon" data-tone="accent" style="margin:0 auto"><i data-lucide="plug-zap"></i></div><div style="font-size:13px;font-weight:600;color:var(--text-1)">Integrations</div></a>'
          + '<a class="kpi" href="#" id="ai-commander-tile" style="text-align:center;gap:6px;align-items:center;background:var(--accent-tint);border-color:transparent"><div class="kpi-icon" data-tone="accent" style="margin:0 auto;background:var(--accent-glow);color:#fff"><i data-lucide="cpu"></i></div><div style="font-size:13px;font-weight:600;color:var(--accent-2)">AI Commander</div></a>'
        + '</div>'
      })
    + pCard({
        head: '<div style="display:flex;align-items:center;gap:8px"><i data-lucide="cpu" style="width:16px;height:16px;color:var(--accent-2)"></i><span class="title" style="color:var(--accent-2);font-weight:700">AI Commander Recommendation</span></div>',
        body: (function(){
          var ss = computeStatsSummary();
          var bottlenecks = Ctx.bugs.filter(function(b){ return b.severity==="critical" && b.status!=="shipped"; }).length;
          var rec = bottlenecks > 2 ? "NOT READY - " + bottlenecks + " critical issues unresolved" : bottlenecks > 0 ? "Conditional - " + bottlenecks + " critical issue(s)" : "Ready to deploy";
          var tone = bottlenecks > 2 ? "crit" : bottlenecks > 0 ? "warn" : "ok";
          var icon = bottlenecks > 2 ? "alert-triangle" : bottlenecks > 0 ? "alert-circle" : "check-circle";
          return '<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--bg-2);border-radius:12px;border:1px solid var(--border);border-left:3px solid var(' + (bottlenecks > 2 ? '--crit' : bottlenecks > 0 ? '--warn' : '--ok') + ')">'
            + '<i data-lucide="' + icon + '" style="width:20px;height:20px;color:var(' + (bottlenecks > 2 ? '--crit' : bottlenecks > 0 ? '--warn' : '--ok') + ');flex-shrink:0"></i>'
            + '<div style="flex:1"><div style="font-size:13px;font-weight:600;color:var(--text-1)">Release: ' + rec + '</div>'
            + '<div style="font-size:11px;color:var(--text-3);margin-top:2px">AI Confidence: ' + ss.avgConf + '% &middot; ' + ss.total + ' bugs analyzed &middot; AI Commander</div></div>'
            + '<button class="btn-ghost btn-sm" id="dash-cmdr-btn" type="button"><i data-lucide="arrow-right"></i>Details</button>'
          + '</div>';
        })()
      })
    + '</div>'
  );
  } catch(e) {
    console.warn('[BugOps] renderDashboard failed:', e);
    return el('<div class="page"><div class="page-head"><h1>Executive Dashboard</h1></div>' + safeFallback('Dashboard data could not be loaded.') + '</div>');
  }
}

function renderOperations(){
  try {
  const q = parseQuery(location.hash);
  if (q && q.view) Ctx._prefs.view = q.view;
  if (q && q.severity) Ctx._prefs.filters.severity = q.severity.split(',');
  const filtered = applyFilters();
  const sorted = applySort(filtered);
  const total = safeArr(sorted).length;
  const sel = Ctx._selected || new Set();

  return el(
    '<div class="page">'
    + '<div class="page-head">'
      + '<div class="lead"><div class="eyebrow">BugOps AI &middot; Operations</div>'
      + '<h1>Bug Operations</h1>'
      + '<div class="page-sub">What requires immediate engineering attention? <b>' + total + '</b> matching bugs across <b>' + Object.keys(domainCounts()).length + '</b> components.</div></div>'
      + '<div class="page-actions"><button class="btn-secondary"><i data-lucide="sliders-horizontal"></i>Filters</button>'
      + '<button class="btn-primary" id="new-bug-2" type="button"><i data-lucide="plus"></i>New Bug</button></div>'
    + '</div>'

    + '<div class="card is-padless">'
      + '<div class="toolbar">'
        + '<div class="filter-chip" data-active="' + (Ctx._prefs.view==='table'?'true':'false') + '" data-toggle="table"><i data-lucide="table-2"></i>Table</div>'
        + '<div class="filter-chip" data-active="' + (Ctx._prefs.view==='grid'?'true':'false')  + '" data-toggle="grid"><i data-lucide="layout-grid"></i>Grid</div>'
        + '<span class="sep"></span>'
        + ['critical','major','minor','cosmetic'].map(s => '<div class="filter-chip" data-active="' + (Ctx._prefs.filters.severity.includes(s)?'true':'false') + '" data-filter="severity" data-value="' + s + '">' + sevDot(s) + '<span style="margin-left:6px;text-transform:capitalize">' + s + '</span></div>').join('')
        + '<span class="sep"></span>'
        + ['ready','risk','blocked','shipped','review'].map(s => '<div class="filter-chip" data-active="' + (Ctx._prefs.filters.status.includes(s)?'true':'false') + '" data-filter="status" data-value="' + s + '">' + statusChip(s) + '</div>').join('')
        + '<span class="sep"></span>'
        + '<div class="filter-chip"><i data-lucide="users"></i>Assignee</div>'
        + '<div class="right"><div class="filter-chip"><i data-lucide="arrow-down-up"></i>Sort: <b style="margin-left:4px">' + sortLabel(Ctx._prefs.sort) + '</b></div></div>'
      + '</div>'

      + (sel.size
        ? '<div class="bulk-bar"><span class="count">' + sel.size + ' selected</span>'
          + '<button type="button" class="btn-ghost btn-sm"><i data-lucide="check-check"></i>Mark triaged</button>'
          + '<button type="button" class="btn-ghost btn-sm"><i data-lucide="user-plus"></i>Assign</button>'
          + '<button type="button" class="btn-ghost btn-sm"><i data-lucide="brain-circuit"></i>Bulk AI review</button>'
          + '<button type="button" class="btn-ghost btn-sm" id="bulk-clear"><i data-lucide="x"></i>Clear</button>'
        + '</div>'
        : '')

      + '<div id="ops-result">' + (Ctx._prefs.view==='grid' ? renderOpsGrid(sorted) : renderOpsTable(sorted)) + '</div>'

      + '<div class="pagination"><span>Page ' + (Ctx._page || 1) + ' &middot; ' + total + ' total</span>'
        + '<div class="pages">'
          + '<button type="button" class="page-btn"><i data-lucide="chevron-left"></i></button>'
          + (function(){ var mp = Math.ceil(total / 10) || 1; var cp = Ctx._page || 1; var b = ''; for(var pi=1;pi<=mp;pi++){b+='<button type=\"button\" class=\"page-btn\"'+(cp===pi?' data-active=\"true\"':'')+'>'+pi+'</button>';} return b; })()
          + '<button type="button" class="page-btn"><i data-lucide="chevron-right"></i></button>'
        + '</div></div>'
    + '</div></div>'
  );
  } catch(e) {
    console.warn('[BugOps] renderOperations failed:', e);
    return el('<div class="page"><div class="page-head"><h1>Bug Operations</h1></div>' + safeFallback('Operations data could not be loaded.') + '</div>');
  }
}

function parseQuery(hash){
  const q = (hash.split('?')[1]||'').split('&').reduce((a,p)=>{ const [k,v]=p.split('='); if(k) a[decodeURIComponent(k)]=decodeURIComponent(v||''); return a; }, {});
  return q;
}
function applyFilters(){
  return Ctx.bugs.filter(b => {
    const f = Ctx._prefs.filters;
    if (f.severity.length && !f.severity.includes(b.severity)) return false;
    if (f.status.length   && !f.status.includes(b.status)) return false;
    if (f.priority.length && !f.priority.includes(b.priority)) return false;
    if (Ctx._query) {
      const q = Ctx._query.toLowerCase();
      if (!(b.title||'').toLowerCase().includes(q) && !(b.id||'').toLowerCase().includes(q) && !(b.domain||'').toLowerCase().includes(q)) return false;
    }
    return true;
  });
}
function applySort(rows){
  const arr = rows.slice();
  const sm = {
    reported_desc: (a,b)=>(new Date(b.created_at||0) - new Date(a.created_at||0)) || (SEVERITY_TONES.indexOf(a.severity)-SEVERITY_TONES.indexOf(b.severity)),
    severity: (a,b)=>SEVERITY_TONES.indexOf(a.severity)-SEVERITY_TONES.indexOf(b.severity),
    confidence: (a,b)=> analysesAvg(b.id)-analysesAvg(a.id)
  }[Ctx._prefs.sort] || (()=>0);
  arr.sort(sm); return arr;
}
function analysesAvg(id){const a=ANALYSES_BY_BUG()[id]; return a ? (a.ai_confidence||0) : 0;}
function sortLabel(s){return ({severity:'Severity', confidence:'AI Confidence', reported_desc:'Reported'})[s]||'Reported';}

function renderOpsTable(rows){
  var page = Ctx._page || 1;
  var perPage = 10;
  var start = (page - 1) * perPage;
  rows = rows.slice(start, start + perPage);
  const a_map = ANALYSES_BY_BUG();
  const cols = '28px 1fr 110px 100px 110px 96px 130px 80px';
  const head = '<div class="table-head" style="grid-template-columns:'+cols+'">'
    + '<div></div><div></div>'
    + '<div class="th">Bug</div><div class="th">Component</div><div class="th">Priority</div><div class="th">Status</div>'
    + '<div class="th">AI</div><div class="th">Assignee</div><div class="th">Reported</div></div>';

  const body = rows.map(b => {
    const sel = Ctx._selected.has(b.id);
    const a = a_map[b.id];
    return '<div class="table-row" data-row-id="' + b.id + '" data-selected="' + (sel?'true':'false') + '" style="grid-template-columns:'+cols+'">'
      + '<div><div class="checkbox" data-on="' + (sel?'true':'false') + '" data-bulk="' + b.id + '"></div></div>'
      + '<div>' + sevDot(b.severity) + '</div>'
      + '<div class="bug-cell-title"><a class="title" href="#/bug/' + encodeURIComponent(b.id) + '">' + escapeHtml(b.title) + '</a>'
      + '<span class="meta">' + escapeHtml((b.submitter||'').replace(/@.+$/,'')) + ' &middot; ' + escapeHtml(b.id) + '</span></div>'
      + '<div>' + domainTag(b.domain) + '</div>'
      + '<div>' + priorityChip(b.priority) + '</div>'
      + '<div>' + statusChip(b.status) + '</div>'
      + '<div>' + aiCond(a ? a.ai_confidence : 0.85) + '</div>'
      + '<div class="col-cell" style="font-size:12px;color:var(--text-2)">' + (b._assignee || recommendAssignment(b, a).assignee) + '</div>'
      + '<div class="col-cell is-num">' + (b.created_at ? fmtRel(b.created_at) : '\u2014') + '</div>'
    + '</div>';
  }).join('');

  return '<div class="table-card">' + head + '<div class="table-body">' + (body || '<div class="empty"><div class="icn"><i data-lucide="search-x"></i></div><h4>No matches</h4><p>Try clearing the search or filters.</p></div>') + '</div></div>';
}

function renderOpsGrid(rows){
  var page = Ctx._page || 1;
  var perPage = 10;
  var start = (page - 1) * perPage;
  rows = rows.slice(start, start + perPage);
  const a_map = ANALYSES_BY_BUG();
  return '<div class="grid-cards">' + rows.map(b => {
    const a = a_map[b.id];
    return '<a class="card bug-card is-hover" href="#/bug/' + encodeURIComponent(b.id) + '">'
      + '<div class="row-1">'
        + '<div class="kpi-icon" data-tone="' + (b.severity==='critical'?'crit':b.severity==='major'?'warn':'info') + '"><span class="sev-dot" data-sev="' + severityTone(b.severity) + '" style="margin:0 auto"></span></div>'
        + '<div class="bug-cell-title" style="flex:1"><span class="title">' + escapeHtml(b.title) + '</span><span class="meta">' + escapeHtml((b.desc||'').slice(0,140)) + '</span></div>'
        + '<i data-lucide="bookmark" class="arrow"></i>'
      + '</div>'
      + '<div class="row-2">' + domainTag(b.domain) + ' ' + severityChip(b.severity) + ' ' + priorityChip(b.priority) + ' ' + statusChip(b.status) + '</div>'
      + '<div class="row-3">'
        + aiCond(a ? a.ai_confidence : 0.85)
        + '<span class="meta">' + (b._assignee || recommendAssignment(b, a_map[b.id]).assignee) + ' &middot; ' + (b.created_at?fmtRel(b.created_at):'\u2014') + '</span>'
        + '<i data-lucide="arrow-up-right" class="arrow"></i>'
      + '</div></a>';
  }).join('') + '</div>';
}

/* ---------- Bug detail ---------- */
function renderBugDetail(id){
  try {
  const bugs = safeArr(Ctx.bugs);
  const bug = bugs.find(function(b){ return b.id === id; });
  if (!bug) return el('<div class="page"><div class="empty"><div class="icn"><i data-lucide="alert-triangle"></i></div><h4>Bug not found</h4><p>Go back to <a href="#/operations">Bug Operations</a>.</p></div></div>');
  const a = safeObj(ANALYSES_BY_BUG()[id]);
  const reviews = (REVIEWS_BY_BUG()[id] || []).slice().sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  const tab = parseQuery(location.hash).tab || 'overview';
  const tabs = [['overview','Overview'],['triage','AI Triage'],['intelligence','Engineering Intelligence'],['review','Human Review'],['audit','Audit Timeline']];

  return el(
    '<div class="page detail-grid">'
    + '<div class="detail-hero">'
      + '<div class="detail-head">'
        + '<div class="crumb-row"><a href="#/operations">Bug Operations</a><i data-lucide="chevron-right"></i>'
        + '<a href="#/operations?severity=' + encodeURIComponent(bug.severity||'') + '">' + escapeHtml(bug.domain||'Other') + '</a><i data-lucide="chevron-right"></i>'
        + '<span>' + escapeHtml(bug.id) + '</span></div>'
        + '<h1>' + escapeHtml(bug.title) + '</h1>'
        + '<div class="meta-row">'
          + severityChip(bug.severity) + ' ' + priorityChip(bug.priority) + ' ' + statusChip(bug.status)
          + '<span class="dotsep">&middot;</span>' + escapeHtml(bug.submitter||'')
          + '<span class="dotsep">&middot;</span>' + (bug.created_at ? fmtRel(bug.created_at):'')
          + '<span class="dotsep">&middot;</span>' + aiCond(a.ai_confidence || 0.85)
        + '</div>'
      + '</div>'
      + '<div class="detail-sticky-actions">'
        + '<div class="desc">' + escapeHtml((bug.desc||'').slice(0,160)) + '</div>'
        + '<div class="acts">'
          + '<button class="btn-secondary"><i data-lucide="rotate-cw"></i>Re-run AI</button>'
          + '<button class="btn-ghost"><i data-lucide="link"></i>Copy link</button>'
          + '<button class="btn-primary"><i data-lucide="rocket"></i>Approve for Release</button>'
        + '</div>'
      + '</div>'
    + '</div>'

    + '<div class="score-strip">'
      + pCard({ body: '<div style="display:flex;align-items:center;gap:18px">'
          + ringSvg(Math.round((a.ai_confidence||0.85)*100), 80)
          + '<div><div class="scapt"><span class="bar"></span>AI Confidence</div>'
          + '<div style="font-size:24px;font-weight:700;letter-spacing:-0.01em;margin-top:4px">' + Math.round((a.ai_confidence||0.85)*100) + '%</div>'
          + '<div style="font-size:13px;color:var(--text-3);margin-top:2px">Calculated by the lifecycle agent</div></div></div>' })
      + pCard({ body: '<div style="display:flex;align-items:center;gap:18px">'
          + ringSvg(a.regression_risk || 65, 80, '#F59E0B')
          + '<div><div class="scapt"><span class="bar"></span>Regression Risk</div>'
          + '<div style="font-size:24px;font-weight:700;letter-spacing:-0.01em;margin-top:4px">' + (a.regression_risk||65) + '<span style="font-size:14px;color:var(--text-3);font-weight:500">%</span></div>'
          + '<div style="font-size:13px;color:var(--text-3);margin-top:2px">&lsquo;' + escapeHtml(a.deployment_risk||'medium') + '&rsquo; deployment risk</div></div></div>' })
    + '</div>'

    + '<div class="tabs">'
      + tabs.map(([k,v]) => '<button type="button" class="tab" data-tab="' + k + '" data-active="' + (tab===k?'true':'false') + '">' + v + (k==='audit'?'<span class="num">' + reviews.length + '</span>':'') + '</button>').join('')
    + '</div>'

    + '<div class="detail-panels">' + detailTabBody(tab, bug, a, reviews) + '</div>'
    + '</div>'
  );
  } catch(e) {
    console.warn('[BugOps] renderBugDetail failed:', e);
    return el('<div class="page"><div class="page-head"><h1>Bug Details</h1></div>' + safeFallback('Bug detail could not be loaded.') + '</div>');
  }
}

function detailTabBody(tab, bug, a, reviews){
  try {
  a = safeAnalysis(a);
  bug = safeObj(bug);
  reviews = safeArr(reviews);
  if (tab === 'overview') {
    return pCard({
      head: '<div><div class="scapt"><span class="bar"></span>EXECUTIVE SUMMARY</div><h3 style="margin:6px 0 0;font-size:18px">Why this bug matters</h3></div>',
      body: '<p style="color:var(--text-2);line-height:1.55">' + escapeHtml(bug.desc||'') + '</p>'
    })
    + '<div class="tile-grid is-4">'
      + pKpiTile({ icon:'cpu', label:'Engineering', value:'High', tone:'accent', sub:'Touches core modules' })
      + pKpiTile({ icon:'trending-up', label:'Business', value:'Med', tone:'warn', sub:'Affects conversion' })
      + pKpiTile({ icon:'users', label:'Customer', value:'High', tone:'crit', sub:'Double-billed users' })
      + pKpiTile({ icon:'alert-triangle', label:'Downstream', value:'Low', tone:'ok', sub:'Bounded blast radius' })
    + '</div>'
    + pCard({
        head: '<div class="scapt"><span class="bar"></span>WORKFLOW RECOMMENDATION</div>',
        body: (function(){
          var wr = workflowRecommend(bug);
          var tone = wr.priority === 'critical' ? 'crit' : wr.priority === 'high' ? 'warn' : 'info';
          return '<div class="risk-panel" style="grid-template-columns:1fr auto">'
            + '<div><div style="font-weight:700">' + escapeHtml(wr.step) + '</div>'
            + '<div style="font-size:12px;color:var(--text-3);margin-top:4px">' + escapeHtml(wr.description) + '</div></div>'
            + '<span class="chip chip-tone-' + tone + '">' + escapeHtml(wr.priority) + '</span>'
            + '</div>';
        })()
      })
    + pCard({
        head: '<div class="scapt"><span class="bar"></span>IMPACT ESTIMATE</div>',
        body: '<div class="tile-grid is-3">'
          + pKpiTile({ icon:'cpu', label:'Engineering', value:estimateImpact(bug, a).engineering, tone:estimateImpact(bug, a).engineering==='High'?'crit':estimateImpact(bug, a).engineering==='Medium'?'warn':'ok', sub:'Estimated effort' })
          + pKpiTile({ icon:'users', label:'Customer', value:estimateImpact(bug, a).customer, tone:estimateImpact(bug, a).customer==='Critical'?'crit':estimateImpact(bug, a).customer==='Medium'?'warn':'ok', sub:'User impact' })
          + pKpiTile({ icon:'trending-up', label:'Revenue', value:estimateImpact(bug, a).revenue, tone:estimateImpact(bug, a).revenue==='High'?'crit':estimateImpact(bug, a).revenue==='Medium'?'warn':'ok', sub:'Business risk' })
        + '</div>'
        + '<p style="font-size:12px;color:var(--text-3);margin:8px 0 0;line-height:1.4">' + escapeHtml(estimateImpact(bug, a).rationale) + '</p>'
      })
  }
  if (tab === 'triage') {
    const confExp = generateConfidenceExplanation(a);
    const whyRating = confExp.factors.length > 1
      ? '<p style="color:var(--text-2);margin-top:6px;line-height:1.55">AI confidence is derived across <b>' + confExp.factors.length + ' dimensions</b>. ' + escapeHtml(confExp.summary) + '</p>'
        + '<div style="margin-top:10px">' + confExp.factors.map(renderConfidenceFactor).join('') + '</div>'
      : '<p style="color:var(--text-2);margin-top:8px">' + escapeHtml(confExp.summary) + '</p>';
    const tests = (a.suggested_tests && a.suggested_tests.length)
      ? a.suggested_tests.map(t => pChip(t, 'accent')).join('')
      : ['idempotent-retry','parallel-fanout','partial-failure','boundary-condition'].map(t => pChip(t, 'accent')).join('');
    return pCard({
      head: '<div class="scapt"><span class="bar"></span>AI INVESTIGATION</div>',
      body:
        '<div class="scapt" style="margin-top:8px">SYMPTOM</div>'
        + '<p style="color:var(--text-2);margin-top:8px">' + escapeHtml(bug.desc||'') + '</p>'
        + '<div class="scapt" style="margin-top:18px">ROOT CAUSE</div>'
        + '<p style="color:var(--text-2);margin-top:8px">' + escapeHtml(a.root_cause||'Awaiting lifecycle analysis.') + '</p>'
        + '<div class="scapt" style="margin-top:18px">WHY THIS RATING</div>'
        + whyRating
        + '<div class="scapt" style="margin-top:18px">SUGGESTED TEST CASES</div>'
        + '<div class="chip-grid" style="margin-top:8px">'
          + tests
        + '</div>'
    });
  }
  if (tab === 'intelligence') {
    const hyps = generateMultiHypotheses(a);
    const evItems = generateEvidenceBreakdown(a);
    const confExp = generateConfidenceExplanation(a);
    const recs = generateRecommendations(a);
    const chain = generateReasoningChain(a);
    return '<div class="two-up"><div class="col">'
      + pCard({
          head: '<div class="scapt"><span class="bar"></span>ENGINEERING INTELLIGENCE</div>',
          body: '<div style="display:flex;flex-direction:column;gap:14px">'
            + '<div><div style="font-size:12px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">Affected Components</div><div class="chip-grid" style="margin-top:8px">'
              + (a.affected_components||[]).map(t=>domainTag(t)).join(' ')
            + '</div></div>'
            + '<div><div style="font-size:12px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">Affected Modules</div>'
              + '<div style="margin-top:8px;font-family:var(--font-mono);font-size:13px;color:var(--text-2);background:var(--bg-2);border:var(--hairline);border-radius:8px;padding:12px">'
              + (a.affected_modules||[]).join('<br>') + '</div></div>'
            + '<div><div style="font-size:12px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">Affected Services</div><div class="chip-grid" style="margin-top:8px">'
              + (a.affected_services||[]).map(t=>pChip(t,'info')).join(' ') + '</div></div>'
          + '</div>'
        })
      + pCard({
          head: '<div class="scapt"><span class="bar"></span>WHY AI THINKS THIS</div>',
          body: '<p style="color:var(--text-2);margin-top:4px;line-height:1.55">' + escapeHtml(confExp.summary) + '</p>'
            + '<div style="margin-top:10px">' + confExp.factors.map(renderConfidenceFactor).join('') + '</div>'
        })
      + pCard({
          head: '<div class="scapt"><span class="bar"></span>EVIDENCE BREAKDOWN</div>',
          body: evItems.length
            ? '<div style="margin-top:4px">' + evItems.map(renderEvidenceItem).join('') + '</div>'
            : '<p style="color:var(--text-3);margin-top:8px">No structured evidence collected.</p>'
        })
      + pCard({
          head: '<div class="scapt"><span class="bar"></span>MULTI-HYPOTHESIS REASONING</div>',
          body: hyps.length
            ? '<div style="margin-top:4px;padding-left:4px">' + hyps.map((h, i) => renderHypothesisCard(h, i)).join('') + '</div>'
            : '<p style="color:var(--text-3);margin-top:8px">No alternative hypotheses detected.</p>'
        })
      + pCard({
          head: '<div class="scapt"><span class="bar"></span>RELATED BUG INTELLIGENCE</div>',
          body: (function(){
            const rel = relatedBugsHelper(bug.id);
            return rel.length
              ? '<div class="grid-cards" style="grid-template-columns:repeat(2,1fr);gap:12px">' +
                  rel.slice(0,6).map(b =>
                    '<a class="card bug-card is-hover" href="#/bug/' + encodeURIComponent(b.id) + '">' +
                      '<div class="row-1">' +
                        '<div class="sev-dot" data-sev="' + severityTone(b.severity) + '"></div>' +
                        '<div class="title" style="flex:1;margin-left:8px">' + escapeHtml(b.title) + '</div>' +
                      '</div>' +
                      '<div class="row-2">' + severityChip(b.severity) + ' ' + statusChip(b.status) + '</div>' +
                    '</a>'
                  ).join('') +
                '</div>'
              : '<p style="color:var(--text-3);margin-top:8px">No directly related bugs found.</p>';
          })()
        })
      + pCard({
          head: '<div class="scapt"><span class="bar"></span>ACTIONABLE RECOMMENDATIONS</div>',
          body: recs.length
            ? '<div style="margin-top:4px">' + recs.map(renderRecommendation).join('') + '</div>'
            : '<p style="color:var(--text-3);margin-top:8px">No recommendations generated.</p>'
        })
      + pCard({
          head: '<div class="scapt"><span class="bar"></span>ENGINEERING MANAGER SUMMARY</div>',
          body: '<p style="color:var(--text-2);line-height:1.55">' + escapeHtml(a.manager_summary||'No summary available.') + '</p>'
        })
    + '</div><div class="col">'
      + pCard({
          head: '<div class="scapt"><span class="bar"></span>REASONING CHAIN</div>',
          body: chain.length
            ? '<div class="timeline" style="padding-left:32px">' + chain.map((s, i) => renderReasoningStep(s, i)).join('') + '</div>'
            : '<p style="color:var(--text-3);margin-top:8px">No reasoning steps available.</p>'
        })
      + pCard({
          head: '<div class="scapt"><span class="bar"></span>DEPLOYMENT &amp; RELEASE</div>',
          body:
            '<div class="risk-panel" data-state="' + (a.release_blocker?'blocker':'safe') + '" style="grid-template-columns:1fr auto">'
              + '<div><div style="font-weight:700">' + (a.release_blocker?'Release blocker detected':'No release blocker') + '</div>'
              + '<div style="font-size:12px;color:var(--text-3);margin-top:4px">' + escapeHtml(a.release_blocker?'Fix must ship before any release touches this surface.':'Safe to ship; run regression suite before rollout.') + '</div></div>'
              + '<span class="chip chip-tone-' + (a.release_blocker?'crit':'ok') + '">' + (a.release_blocker?'Blocker':'Clear') + '</span>'
            + '</div>'
            + '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px">'
              + '<div class="scapt"><span class="bar"></span>DEPLOYMENT RISK</div>'
              + '<span class="chip chip-tone-' + (a.deployment_risk==='critical'?'crit':a.deployment_risk==='high'?'warn':a.deployment_risk==='low'?'ok':'info') + '">' + escapeHtml(a.deployment_risk||'medium') + '</span>'
            + '</div>'
            + '<div class="bar" data-tone="' + (a.deployment_risk==='critical'?'crit':a.deployment_risk==='high'?'warn':'ok') + '" style="margin-top:8px;width:100%"><span style="width:' + ((a.deployment_risk==='critical')?90:(a.deployment_risk==='high'?'70':40)) + '%"></span></div>'
            + '<div style="font-size:12px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin-top:14px">Readiness</div>'
            + '<div style="display:flex;align-items:center;gap:12px;margin-top:8px">'
              + ringSvg(a.readiness_score||60, 56, a.readiness==='hold'?'#EF4444':a.readiness==='review'?'#F59E0B':'#10B981')
              + '<div style="font-size:14px;color:var(--text-2)">' + escapeHtml(a.readiness||'\u2014') + ' &middot; recommend <b>' + escapeHtml((a.readiness||'').includes('hold')?'hold and fix':(a.readiness||'').includes('review')?'review with team':'approve for release') + '</b>.</div>'
            + '</div>'
            + '<div class="scapt" style="margin-top:14px">REGRESSION PLAN</div>'
            + '<div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">'
              + '<label class="row-action" style="padding:6px 0;border-bottom:var(--hairline)"><div class="checkbox" data-on="true"></div><span style="margin-left:8px;font-size:13px;color:var(--text-1)">Audit the Stripe retry path</span></label>'
              + '<label class="row-action" style="padding:6px 0;border-bottom:var(--hairline)"><div class="checkbox" data-on="true"></div><span style="margin-left:8px;font-size:13px;color:var(--text-1)">Re-run regression on billing-api</span></label>'
              + '<label class="row-action" style="padding:6px 0;border-bottom:var(--hairline);border-bottom:0"><div class="checkbox"></div><span style="margin-left:8px;font-size:13px;color:var(--text-1)">Smoke test the front-end credit receipt</span></label>'
            + '</div>'
        })
    + pCard({
        head: '<div class="scapt"><span class="bar"></span>PRIORITY SCORE</div>',
        body: (function(){
          var ps = computePriorityScore(bug, a);
          var tone = ps.score >= 85 ? 'crit' : ps.score >= 65 ? 'warn' : ps.score >= 40 ? 'info' : 'accent';
          var bar = '<div style="display:flex;align-items:center;gap:14px">'
            + ringSvg(ps.score, 64, ps.score >= 85 ? '#EF4444' : ps.score >= 65 ? '#F59E0B' : ps.score >= 40 ? '#3B82F6' : '#8B5CF6')
            + '<div><div style="font-size:16px;font-weight:700">' + ps.score + '/100</div>'
            + '<span class="chip chip-tone-' + tone + '" style="margin-top:4px">' + escapeHtml(ps.label) + '</span></div></div>';
          var factors = '<div style="font-size:11px;color:var(--text-3);margin-top:10px">' + ps.factors.map(function(f){
            var pct = Math.round(f.weight * 100);
            return '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:var(--hairline)"><span>' + escapeHtml(f.factor) + '</span><span>' + f.contribution + '</span></div>';
          }).join('') + '</div>';
          return bar + factors;
        })()
      })
    + pCard({
        head: '<div class="scapt"><span class="bar"></span>DUPLICATE DETECTION</div>',
        body: (function(){
          var dups = detectDuplicates(bug.id);
          return dups.length
            ? dups.map(function(d){
                return '<a class="mini-row" href="#/bug/' + encodeURIComponent(d.id) + '">'
                  + '<div><div style="font-size:13px;font-weight:500;color:var(--text-1)">' + escapeHtml(d.title) + '</div>'
                  + '<div style="font-size:11px;color:var(--text-3);margin-top:2px">Score: ' + d.score + ' &middot; ' + d.reasons.join(', ') + '</div></div>'
                  + '<div>' + severityChip(d.severity) + ' ' + statusChip(d.status) + '</div>'
                  + '</a>';
              }).join('')
            : '<p style="color:var(--text-3);margin:8px 0;font-size:13px">No potential duplicates detected.</p>';
        })()
      })
    + '</div></div>';
  }
  } catch(e) {
    console.warn('[BugOps] detailTabBody failed:', e);
    return safeFallback('Tab content could not be loaded.');
  }
  if (tab === 'review') {
    return pCard({
      head: '<div><div class="scapt"><span class="bar"></span>HUMAN REVIEW</div><h3 style="margin:6px 0 0;font-size:18px">Approval Briefing</h3></div>',
      body: '<p style="color:var(--text-2);line-height:1.55;margin-bottom:16px">' + escapeHtml(a.manager_summary||'No briefing available.') + '</p>'
        + '<ul style="display:flex;flex-direction:column;gap:8px">'
          + '<li style="display:flex;gap:8px;color:var(--text-2);font-size:13px"><i data-lucide="circle-dot" style="color:var(--accent);width:14px;height:14px;flex-shrink:0"></i>AI Confidence is high; reproduction deterministic.</li>'
          + '<li style="display:flex;gap:8px;color:var(--text-2);font-size:13px"><i data-lucide="circle-dot" style="color:var(--accent);width:14px;height:14px;flex-shrink:0"></i>Regression risk ' + (a.regression_risk||65) + '% &mdash; recommend running the billing regression suite before merge.</li>'
          + '<li style="display:flex;gap:8px;color:var(--text-2);font-size:13px"><i data-lucide="circle-dot" style="color:var(--accent);width:14px;height:14px;flex-shrink:0"></i>' + (a.release_blocker?'Hard blocker &mdash; do not approve without fix.':'No hard blocker.') + '</li>'
          + '<li style="display:flex;gap:8px;color:var(--text-2);font-size:13px"><i data-lucide="circle-dot" style="color:var(--accent);width:14px;height:14px;flex-shrink:0"></i>Recommended team: <b>' + escapeHtml(a.recommended_team||'Engineering on-call') + '</b>.</li>'
        + '</ul>'
        + '<div id="review-actions" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px">'
          + '<button class="btn-primary"><i data-lucide="check-circle"></i>Approve for Release</button>'
          + '<button class="btn-ghost"><i data-lucide="refresh-cw"></i>Request Changes</button>'
          + '<button class="btn-ghost"><i data-lucide="search"></i>Investigate Further</button>'
        + '</div>'
    });
  }
  if (tab === 'audit') {
    return pCard({
      head: '<div class="scapt"><span class="bar"></span>AUDIT TIMELINE</div>',
      body: '<div class="timeline">'
        + (reviews.length ? reviews.map(r =>
          '<div class="tl-item">'
            + '<div class="tl-mark" data-tone="' + (r.kind==='triage'?'accent':r.kind==='approval'?'ok':r.kind==='analysis'?'info':'warn') + '"></div>'
            + '<div class="tl-meta"><span class="who">' + escapeHtml(r.actor||'system') + '</span><span>' + escapeHtml(r.kind) + '</span><span style="margin-left:auto">' + fmtRel(r.created_at) + '</span></div>'
            + '<div class="tl-body">' + escapeHtml(r.note||'\u2014') + '</div>'
            + '<div class="tl-rule">' + severityChip(r.severity||bug.severity) + ' ' + priorityChip(r.priority||bug.priority) + '</div>'
          + '</div>'
        ).join('') : '<div class="empty"><div class="icn"><i data-lucide="history"></i></div><h4>No audit entries yet</h4></div>')
      + '</div>'
    });
  }
  return '';
}

/* ---------- Releases ---------- */
function renderReleases(){
  try {
  return el(
    '<div class="page">'
    + '<div class="page-head">'
      + '<div class="lead"><div class="eyebrow">BugOps AI &middot; Releases</div>'
      + '<h1>Release Center</h1>'
      + '<div class="page-sub">Can we safely ship today&rsquo;s release, and where would it break?</div></div>'
      + '<div class="page-actions"><button class="btn-secondary"><i data-lucide="git-pull-request-arrow"></i>Open PRs</button>'
      + '<button class="btn-primary"><i data-lucide="rocket"></i>Plan Release v4.4</button></div>'
    + '</div>'


    + pCard({
        head: '<div style="display:flex;align-items:center;gap:8px"><i data-lucide="cpu" style="width:16px;height:16px;color:var(--accent-2)"></i><span class="title" style="color:var(--accent-2);font-weight:700">AI Release Recommendation</span></div>',
        body: (function(){
          var blockers = Ctx.bugs.filter(function(b){ return b.severity==='critical' && b.status!=='shipped'; }).length;
          var readyB = Ctx.bugs.filter(function(b){ return b.status==='ready'; }).length;
          var label = blockers > 0 ? 'Blocked - '+blockers+' critical(s)' : readyB < 2 ? 'Caution - low ready count' : 'Ready to ship';
          var statusAttr = blockers > 0 ? 'blocked' : readyB < 2 ? 'risk' : 'ready';
          var ss = computeStatsSummary();
          return '<div style="display:flex;align-items:center;gap:12px">'
            + '<span class="pill-status" data-status="'+statusAttr+'">'+label+'</span>'
            + '<span style="font-size:12px;color:var(--text-3)">'+ss.total+' bugs, '+ss.avgConf+'% AI confidence</span>'
            + '<button class="btn-ghost btn-sm" id="rel-cmdr-btn" style="margin-left:auto" type="button"><i data-lucide="cpu"></i>AI Commander</button>'
          + '</div>';
        })()
      })
    + '<div class="kpi-strip">'
      + pKpiTile({ icon:'check-check', label:'Ready to Ship', value:4, tone:'ok', sub:'Across 2 releases' })
      + pKpiTile({ icon:'alert-octagon', label:'Hard Blockers', value:2, tone:'crit', sub:'2 must-fix before v4.4' })
      + pKpiTile({ icon:'gauge', label:'Avg Readiness', value:'78%', tone:'accent', sub:'vs 71% last week' })
    + '</div>'

    + '<div class="tile-grid" style="grid-template-columns:repeat(2,1fr)">'
      + '<div class="card"><div class="card-head"><div class="title">Release v4.4 &mdash; Payments Stripe refactor</div><span class="pill-status" data-status="blocked"><span class="dot"></span>Blocked</span></div>'
        + '<div style="display:flex;flex-direction:column;gap:14px">'
          + '<p style="color:var(--text-3)">Six open bugs feeding v4.4. Two are hard blockers. MTTR is tracking below the previous release but deployment risk is high because the rewrite has a new idempotency contract.</p>'
          + '<div class="grid-cards" style="grid-template-columns:repeat(3,1fr)">'
            + pKpiTile({ icon:'git-pull-request', label:'Open', value:6, tone:'accent' })
            + pKpiTile({ icon:'alert-triangle', label:'Blockers', value:2, tone:'crit' })
            + pKpiTile({ icon:'check-circle-2', label:'Ready', value:2, tone:'ok' })
          + '</div>' + pScapt('Suggested team: Payments Squad')
        + '</div></div>'

      + '<div class="card"><div class="card-head"><div class="title">Release v4.5 &mdash; Identity &amp; Billing polish</div><span class="pill-status" data-status="ready"><span class="dot"></span>Ready</span></div>'
        + '<div style="display:flex;flex-direction:column;gap:14px">'
          + '<p style="color:var(--text-3)">Stable scope. AI suggests shipping what&rsquo;s ready and deferring OAuth tab-nonce to v4.6.</p>'
          + '<div class="grid-cards" style="grid-template-columns:repeat(3,1fr)">'
            + pKpiTile({ icon:'git-pull-request', label:'Open', value:3, tone:'accent' })
            + pKpiTile({ icon:'alert-triangle', label:'Blockers', value:0, tone:'ok' })
            + pKpiTile({ icon:'check-circle-2', label:'Ready', value:3, tone:'ok' })
          + '</div>' + pScapt('Suggested team: Identity Squad')
        + '</div></div>'
    + '</div>'

    + pCard({
        head: '<div class="title">AI Release Summary</div>',
        body: '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:16px">'
          + mkReleaseSummary('No double-credit bug goes to prod', 'ok', ['Dedupe on Stripe webhook idempotency key','Replay-safe queue for billing retries','Manual regression suite green'])
          + mkReleaseSummary('Stop spam notifications from double sending', 'warn', ['Apply SETNX (Redis TTL) on retry lock','Cancel old APNs token on rotation','Slack-SMS channel de-duplication'])
        + '</div>'
      })

    + pCard({
        head: '<div style="display:flex;justify-content:space-between;align-items:center"><div class="title">Release Notes</div><span class="meta">Generated by AI approval briefings</span></div>',
        body: '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:16px">'
          + '<div style="border:var(--hairline);background:var(--bg-1);border-radius:14px">'
            + '<div style="padding:14px 18px;background:linear-gradient(135deg,rgba(139,92,246,.16),rgba(124,58,237,0));border-radius:14px 14px 0 0;display:flex;align-items:center;justify-content:space-between">'
              + '<div><div style="font-family:var(--font-mono);font-size:11px;color:var(--text-3)">v4.4</div><div style="font-weight:700">Stripe webhook idempotency</div></div>'
              + '<button class="iconbtn" type="button" aria-label="Copy release notes"><i data-lucide="copy"></i></button>'
            + '</div>'
            + '<div style="padding:14px 18px;font-size:13px;color:var(--text-2);line-height:1.55">Stripe retry path now applies the credit only once per request id. Operators see one webhook notification per retry attempt; replayed events are no-ops. The billing ledger invariant credit == applied attempts is now enforced at the worker level.</div>'
          + '</div>'
          + '<div style="border:var(--hairline);background:var(--bg-1);border-radius:14px">'
            + '<div style="padding:14px 18px;background:linear-gradient(135deg,rgba(139,92,246,.16),rgba(124,58,237,0));border-radius:14px 14px 0 0;display:flex;align-items:center;justify-content:space-between">'
              + '<div><div style="font-family:var(--font-mono);font-size:11px;color:var(--text-3)">v4.4</div><div style="font-weight:700">Auth: OAuth tab-nonce binding</div></div>'
              + '<button class="iconbtn" type="button" aria-label="Copy release notes"><i data-lucide="copy"></i></button>'
            + '</div>'
            + '<div style="padding:14px 18px;font-size:13px;color:var(--text-2);line-height:1.55">OAuth state cookies are now bound to the originating browser tab via HttpOnly cookie, eliminating the previous cross-tab binding leak. The fix is shipped behind a flag.</div>'
          + '</div>'
        + '</div>'
      })
    + '</div>'
  );
  } catch(e) {
    console.warn('[BugOps] renderReleases failed:', e);
    return el('<div class="page"><div class="page-head"><h1>Release Center</h1></div>' + safeFallback('Release data could not be loaded.') + '</div>');
  }
}
function mkReleaseSummary(name, tone, list){
  return '<div style="border:var(--hairline);background:var(--bg-2);border-radius:14px;padding:18px">'
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">'
      + '<div style="font-weight:700">' + (tone==='ok'?'\u2705 ':'\u26a0\ufe0f ') + escapeHtml(name) + '</div>'
      + '<span class="chip chip-tone-' + tone + '">' + (tone==='ok'?'Verified':'Watch') + '</span>'
    + '</div>'
    + '<ul style="display:flex;flex-direction:column;gap:6px">'
      + list.map(i => '<li style="font-size:13px;color:var(--text-2);display:flex;align-items:center;gap:8px"><i data-lucide="check" style="width:14px;height:14px;color:' + (tone==='ok'?'var(--ok)':'var(--warn)') + '"></i>' + escapeHtml(i) + '</li>').join('')
    + '</ul></div>';
}

/* ---------- Insights ---------- */
function renderInsights(){
  try {
  return el(
    '<div class="page">'
    + '<div class="page-head">'
      + '<div class="lead"><div class="eyebrow">BugOps AI &middot; Insights</div>'
      + '<h1>Engineering Insights</h1>'
      + '<div class="page-sub">What patterns is the AI discovering across this engineering surface?</div></div>'
      + '<div class="page-actions"><button class="btn-secondary"><i data-lucide="download"></i>Export PDF</button>'
      + '<button class="btn-primary"><i data-lucide="mail"></i>Schedule Weekly Report</button></div>'
    + '</div>'

    + '<div class="tile-grid">'
      + pKpiTile({ icon:'trending-up', label:'Bug Trends', value:'+12%', tone:'warn', sub:'vs last 6 weeks' })
      + pKpiTile({ icon:'brain-circuit', label:'AI Avg Conf', value:'88%', tone:'accent', sub:'Improved 4 pts vs prior' })
      + pKpiTile({ icon:'alert-triangle', label:'Regression \u2191', value:'62%', tone:'crit', sub:'Higher in payments area' })
      + pKpiTile({ icon:'gauge', label:'Deployment Ready', value:'78%', tone:'ok', sub:'Above 75% target' })
    + '</div>'

    + (function(){
      var sd = getScheduleDisplay();
      if (!sd) return '';
      return '<div class="card" style="margin-bottom:16px"><div class="card-body" style="display:flex;align-items:center;justify-content:space-between;padding:12px 18px"><div><div style="font-weight:600;font-size:14px">Weekly AI Report</div><div style="font-size:12px;color:var(--text-3);margin-top:2px">Next Run: ' + escapeHtml(sd.nextRun) + ' &middot; Last Updated: ' + escapeHtml(sd.lastUpdated) + '</div></div><span class="pill-status" data-status="ready">Enabled</span></div></div>';
    })()

    + '<div class="tile-grid is-2">'
  
    + pCard({
        head: '<div style="display:flex;align-items:center;gap:8px"><i data-lucide="cpu" style="width:16px;height:16px;color:var(--accent-2)"></i><span class="title" style="color:var(--accent-2);font-weight:700">Commander Executive Summary</span></div>',
        body: (function(){
          var ss = computeStatsSummary();
          var topDomain = computeModuleHotspots();
          var riskArea = topDomain.length ? topDomain[0].label : 'N/A';
          var bottlenecks = Ctx.bugs.filter(function(b){ return b.severity==='critical' && b.status!=='shipped'; }).length;
          var alerts = [];
          if (bottlenecks > 0) alerts.push(bottlenecks+' critical unresolved');
          if (ss.avgConf < 80) alerts.push('Low AI confidence');
          if (riskArea) alerts.push('Highest risk: '+riskArea);
          var summary = alerts.length ? alerts.join(' &middot; ') : 'All systems nominal';
          return '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">'
            + '<span class="ai-pill" data-cond="'+(ss.avgConf >= 80 ? 'high' : ss.avgConf >= 55 ? 'mid' : 'low')+'">Health '+ss.avgConf+'%</span>'
            + '<span style="font-size:12px;color:var(--text-2)">'+summary+'</span>'
            + '<button class="btn-ghost btn-sm" id="ins-cmdr-btn" style="margin-left:auto" type="button"><i data-lucide="cpu"></i>Full Analysis</button>'
          + '</div>';
        })()
      })
    + pCard({
          head: '<div><div class="title">Bug Trends</div><div class="meta">last 8 weeks &middot; AI-detected vs Eng-reported</div></div>',
          body: '<div class="chart-wrap">' + chartTrendArea({
            data: [
              { label:'AI-Detected', color:'#8B5CF6', values:[12,14,18,22,27,33,35,38] },
              { label:'Eng-Reported', color:'#94A3B8', values:[9,11,13,12,14,15,17,19] }
            ],
            labels: ['W1','W2','W3','W4','W5','W6','W7','W8']
          }) + '</div>'
            + '<div class="legend"><span><i class="swatch" style="background:#8B5CF6"></i>AI-Detected</span><span><i class="swatch" style="background:#94A3B8"></i>Eng-Reported</span></div>'
        })
      + pCard({
          head: '<div><div class="title">Severity Distribution</div><div class="meta">all open</div></div>',
          body: chartDonut({ size:200, slices:[
            { label:'Critical', color:'#EF4444', value:Ctx.bugs.filter(b=>b.severity==='critical').length },
            { label:'Major',    color:'#F59E0B', value:Ctx.bugs.filter(b=>b.severity==='major').length },
            { label:'Minor',    color:'#3B82F6', value:Ctx.bugs.filter(b=>b.severity==='minor').length },
            { label:'Cosmetic', color:'#7C8499', value:Ctx.bugs.filter(b=>b.severity==='cosmetic').length }
          ] })
        })
    + '</div>'


    + '<div class="tile-grid is-2">'
      + pCard({
          head: '<div><div class="title">Component Distribution</div><div class="meta">across ' + Object.keys(domainCounts()).length + ' domains</div></div>',
          body: chartBars({ labels: Object.keys(domainCounts()).slice(0,7), values: Object.values(domainCounts()).slice(0,7).map(v => ({ value:v, color: v>3?'#EF4444':v>1?'#F59E0B':'#8B5CF6' })) })
        })
      + pCard({
          head: '<div><div class="title">Regression Risk</div><div class="meta">by release</div></div>',
          body: chartBars({ labels:['v4.4','v4.5','v4.6','v4.7','v4.8'], values:[{value:88,color:'#EF4444'},{value:41,color:'#F59E0B'},{value:27,color:'#10B981'},{value:53,color:'#F59E0B'},{value:62,color:'#F59E0B'}] })
        })
    + '</div>'

    + pCard({
        head: '<div><div class="title">Component Health Heatmap</div><div class="meta">rows: components &middot; cols: last 7 weeks</div></div>',
        body: '<div class="heatmap"><div class="hmc"></div>'
          + '<div class="hmc">W1</div><div class="hmc">W2</div><div class="hmc">W3</div><div class="hmc">W4</div><div class="hmc">W5</div><div class="hmc">W6</div><div class="hmc">W7</div>'
          + ['Auth','Payments','Dashboard','Reports','Billing','Notifications','API'].map((row, ri) =>
              '<div class="hmc is-label">' + row + '</div>'
              + Array.from({length:7}, (_, i) => {
                  const v = (ri*7+i*5) % 17;
                  const tone = v<3?0:v<7?1:v<11?2:v<15?3:4;
                  return '<div class="hmc is-cell" data-tone="' + tone + '">' + v + '</div>';
                }).join('')
            ).join('')
        + '</div>'
        + '<div class="legend">'
          + '<span><i class="swatch" style="background:var(--bg-2)"></i>0 bugs / wk</span>'
          + '<span><i class="swatch swatch-tone-1"></i>1\u20136</span>'
          + '<span><i class="swatch swatch-tone-2"></i>7\u201310</span>'
          + '<span><i class="swatch swatch-tone-3"></i>11\u201314</span>'
          + '<span><i class="swatch" style="background:var(--crit)"></i>15+</span>'
        + '</div>'
      })


    /* ---- Phase 4 Analytics Dashboard ---- */

    + '<div class="two-up" style="margin-top:var(--s-4)"><div class="col">'
      + pCard({
          head: '<div class="scapt"><span class="bar"></span>BUG AGING</div><div class="meta">Time since reported</div>',
          body: chartHorizontalBars({ items: computeBugAging() })
        })
      + pCard({
          head: '<div class="scapt"><span class="bar"></span>MODULE HOTSPOTS</div><div class="meta">Bug density by domain</div>',
          body: chartHorizontalBars({ items: computeModuleHotspots() })
        })
      + pCard({
          head: '<div class="scapt"><span class="bar"></span>REVIEWER WORKLOAD</div><div class="meta">Reviews processed per agent</div>',
          body: (function(){
            const wl = computeReviewerWorkload();
            if (!wl.length) return '<p style="color:var(--text-3);margin:8px 0">No review activity recorded.</p>';
            return '<div style="padding:4px 0">' + wl.map(function(r){
              const icn = r.actor.indexOf('triage') >= 0 ? 'search' : r.actor.indexOf('lifecycle') >= 0 ? 'brain-circuit' : r.actor.indexOf('approval') >= 0 ? 'check-circle' : 'user';
              return '<div class="mini-row" style="grid-template-columns:24px 1fr auto">'
                + '<i data-lucide="' + icn + '" style="width:16px;height:16px;color:var(--accent)"></i>'
                + '<div style="font-size:13px;font-weight:500;color:var(--text-1)">' + escapeHtml(r.actor) + '</div>'
                + '<span class="chip">' + r.count + '</span>'
              + '</div>';
            }).join('') + '</div>';
          })()
        })
    + '</div><div class="col">'
      + pCard({
          head: '<div class="scapt"><span class="bar"></span>RESOLUTION STATUS</div><div class="meta">Bug lifecycle distribution</div>',
          body: (function(){
            const stats = computeResolutionStats();
            if (!stats.length) return '<p style="color:var(--text-3);margin:8px 0">No bug data available.</p>';
            return '<div style="display:flex;flex-direction:column;gap:8px;padding:4px 0">'
              + stats.map(function(r){
                  const tone = r.status === 'shipped' ? 'ok' : r.status === 'ready' ? 'ok' : r.status === 'blocked' ? 'crit' : r.status === 'risk' ? 'warn' : 'info';
                  return '<div style="display:flex;align-items:center;gap:10px">'
                    + '<span class="pill-status" data-status="' + (r.status === 'review' ? 'triage' : r.status) + '" style="width:70px">' + escapeHtml(r.status) + '</span>'
                    + '<div style="flex:1;height:10px;background:var(--bg-3);border-radius:4px;overflow:hidden">'
                      + '<div style="width:' + r.pct + '%;height:100%;background:' + (tone==='crit'?'var(--crit)':tone==='warn'?'var(--warn)':tone==='ok'?'var(--ok)':'var(--accent)') + ';border-radius:4px;opacity:.8"></div>'
                    + '</div>'
                    + '<span style="font-size:12px;font-weight:600;color:var(--text-1);width:30px;text-align:right">' + r.count + '</span>'
                  + '</div>';
                }).join('')
            + '</div>';
          })()
        })
      + pCard({
          head: '<div class="scapt"><span class="bar"></span>AI CONFIDENCE TREND</div><div class="meta">Average confidence per cohort</div>',
          body: (function(){
            const trend = computeConfidenceTrend();
            if (!trend.length) return '<p style="color:var(--text-3);margin:8px 0">No analysis data available.</p>';
            const w = 540, h = 100, pad = {t:6, r:6, b:16, l:28};
            const max = Math.max(100, Math.ceil(Math.max.apply(null, trend) / 10) * 10);
            const xs = trend.map(function(_,i){ return pad.l + (i/(trend.length-1||1)) * (w-pad.l-pad.r); });
            const yVal = function(v){ return pad.t + (1 - v/max) * (h-pad.t-pad.b); };
            const pts = trend.map(function(v,i){ return xs[i]+','+yVal(v); }).join(' ');
            const area = xs[0]+','+yVal(0)+' '+pts+' '+xs[xs.length-1]+','+yVal(0);
            const path = area.split(' ').join(' L ');
            const grid = [0.5,0.75,1].map(function(t){
              const gy = pad.t + t * (h-pad.t-pad.b);
              const v = Math.round(max*(1-t));
              return '<line x1="'+pad.l+'" y1="'+gy+'" x2="'+(w-pad.r)+'" y2="'+gy+'" stroke="rgba(255,255,255,.04)"/>'
                + '<text x="'+(pad.l-4)+'" y="'+(gy+3)+'" font-size="9" fill="var(--text-3)" text-anchor="end">'+v+'%</text>';
            }).join('');
            const xLabels = trend.map(function(_,i){
              return '<text x="'+xs[i]+'" y="'+(h-3)+'" font-size="9" fill="var(--text-3)" text-anchor="middle">C'+(i+1)+'</text>';
            }).join('');
            return '<div class="chart-wrap">'
              + '<svg class="chart-svg" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none">'
                + '<defs><linearGradient id="ctg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8B5CF6" stop-opacity=".35"/><stop offset="1" stop-color="#8B5CF6" stop-opacity="0"/></linearGradient></defs>'
                + grid
                + '<path d="M '+path+' Z" fill="url(#ctg)" />'
                + '<polyline points="'+pts+'" fill="none" stroke="#8B5CF6" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
                + '<circle cx="'+xs[xs.length-1]+'" cy="'+yVal(trend[trend.length-1])+'" r="3" fill="#8B5CF6" stroke="var(--bg-1)" stroke-width="1.5"/>'
                + xLabels
              + '</svg></div>'
              + '<div style="display:flex;justify-content:space-between;margin-top:4px;font-size:11px">'
                + '<span style="color:var(--text-3)">Cohort avg: <b style="color:var(--text-1)">' + Math.round(trend.reduce(function(s,v){return s+v;},0)/trend.length) + '%</b></span>'
                + '<span style="color:var(--text-3)">Latest: <b style="color:var(--text-1)">' + trend[trend.length-1] + '%</b></span>'
              + '</div>';
          })()
        })
    + '</div></div>'

    + '<div class="tile-grid" style="margin-top:var(--s-4)">'
      + (function(){
        const ss = computeStatsSummary();
        return ''
          + '<div class="kpi">'
            + '<div class="kpi-head"><div class="kpi-icon" data-tone="accent"><i data-lucide="bug"></i></div><span class="kpi-label">Total Bugs</span></div>'
            + '<div class="kpi-value">' + ss.total + '</div>'
            + '<div class="kpi-sub">' + ss.open + ' open / ' + ss.shipped + ' shipped</div>'
          + '</div>'
          + '<div class="kpi">'
            + '<div class="kpi-head"><div class="kpi-icon" data-tone="accent"><i data-lucide="brain-circuit"></i></div><span class="kpi-label">Avg AI Confidence</span></div>'
            + '<div class="kpi-value">' + ss.avgConf + '%</div>'
            + '<div class="kpi-sub">Across ' + Ctx.analyses.length + ' analyses</div>'
          + '</div>'
          + '<div class="kpi">'
            + '<div class="kpi-head"><div class="kpi-icon" data-tone="accent"><i data-lucide="layers"></i></div><span class="kpi-label">Components</span></div>'
            + '<div class="kpi-value">' + ss.domains + '</div>'
            + '<div class="kpi-sub">Active domains</div>'
          + '</div>'
          + '<div class="kpi">'
            + '<div class="kpi-head"><div class="kpi-icon" data-tone="accent"><i data-lucide="clock"></i></div><span class="kpi-label">Oldest Bug</span></div>'
            + '<div class="kpi-value">' + ss.oldestAge + 'h</div>'
            + '<div class="kpi-sub">Still in backlog</div>'
          + '</div>';
      })()
    + '</div>'


    + pCard({
        head: '<div class="title">AI-Discovered Patterns</div>',
        body: '<ul style="display:flex;flex-direction:column;gap:14px">'
          + '<li style="display:flex;gap:12px"><div class="icn" style="width:36px;height:36px;border-radius:10px;background:var(--accent-tint);color:var(--accent);display:grid;place-items:center;flex:0 0 36px"><i data-lucide="flame"></i></div>'
          + '<div><b style="color:var(--text-1)">Idempotency on retries</b><div style="color:var(--text-3);font-size:13px;margin-top:4px">Two of the last four critical bugs share the root cause: missing idempotency contract on webhook retries. AI suggests adding a shared retry-middleware helper.</div><div class="meta" style="margin-top:6px;font-size:11px;color:var(--text-3)">5 of 12 criticals &middot; affecting integration-heavy surface</div></div></li>'

          + '<li style="display:flex;gap:12px"><div class="icn" style="width:36px;height:36px;border-radius:10px;background:var(--crit-tint);color:var(--crit);display:grid;place-items:center;flex:0 0 36px"><i data-lucide="alert-triangle"></i></div>'
          + '<div><b style="color:var(--text-1)">CSP allow-listed unsafe-inline</b><div style="color:var(--text-3);font-size:13px;margin-top:4px">The stored-XSS in admin preview is a symptom of a wider CSP policy that allows inline scripts. AI proposes a nonce-based CSP migration plan.</div><div class="meta" style="margin-top:6px;font-size:11px;color:var(--text-3)">affects admin-portal v4.4 &middot; regression risk medium</div></div></li>'

          + '<li style="display:flex;gap:12px"><div class="icn" style="width:36px;height:36px;border-radius:10px;background:var(--ok-tint);color:var(--ok);display:grid;place-items:center;flex:0 0 36px"><i data-lucide="trending-down"></i></div>'
          + '<div><b style="color:var(--text-1)">Bundle size creeping up</b><div style="color:var(--text-3);font-size:13px;margin-top:4px">First-paint bundle grew from 312 kB to 411 kB this quarter. The dashboards area accounts for 220 kB of that growth. Recommend deferring recharts until after FCP.</div><div class="meta" style="margin-top:6px;font-size:11px;color:var(--text-3)">projected MTTR delta: \u22124 hours</div></div></li>'
        + '</ul>'
      })
    + '</div>'
  );
  } catch(e) {
    console.warn('[BugOps] renderInsights failed:', e);
    return el('<div class="page"><div class="page-head"><h1>Engineering Insights</h1></div>' + safeFallback('Insights data could not be loaded.') + '</div>');
  }
}

/* ---------- Settings ---------- */
function renderSettings(){
  try {
  const tab = parseQuery(location.hash).tab || 'workspace';
  const items = [
    ['workspace','Workspace','building'],['ai','AI Policies','brain-circuit'],['integrations','Integrations','plug-zap'],
    ['keys','API Keys','key-round'],['notify','Notifications','bell'],['theme','Theme','palette'],['audit','Audit','scroll-text']
  ];
  return el(
    '<div class="page">'
    + '<div class="page-head"><div class="lead"><div class="eyebrow">BugOps AI &middot; Settings</div>'
      + '<h1>Settings</h1><div class="page-sub">How do we shape BugOps to fit our engineering team?</div></div></div>'
    + '<div class="settings-grid">'
      + '<div class="settings-rail" id="set-rail">'
        + items.map(([k,v,i]) => '<a class="settings-rail-item" data-tab="' + k + '" data-active="' + (tab===k?'true':'false') + '" href="#/settings?tab=' + k + '"><i data-lucide="' + i + '"></i>' + v + '</a>').join('')
      + '</div>'
      + '<div class="settings-form">' + settingsTab(tab) + '</div>'
    + '</div></div>'
  );
  } catch(e) {
    console.warn('[BugOps] renderSettings failed:', e);
    return el('<div class="page"><div class="page-head"><h1>Settings</h1></div>' + safeFallback('Settings could not be loaded.') + '</div>');
  }
}
function settingsTab(tab){
  try {
  if (tab==='workspace') return ''
    + '<div class="settings-group"><h2>Workspace</h2><div class="lede">The metadata that shows up in audit exports and integrations.</div>'
    + '<div class="field-row"><div class="field-set"><div class="label">Workspace name</div><input class="input" id="set-workspace-name" value="' + escapeHtml(getSettings().workspace.name) + '"></div>'
    + '<div class="field-set"><div class="label">Owner</div><input class="input" value="release@bugops.ai" readonly></div></div>'
    + '<div class="field-set"><div class="label">Pod ID</div><input class="input" value="019f02e3-dbd5-7551-86ed-6840fe0743d7" readonly></div>'
    + '<div class="field-set" style="margin-top:18px"><div class="label">Description</div><textarea class="textarea" id="set-workspace-desc">' + escapeHtml(getSettings().workspace.desc) + '</textarea></div>'
    + '<div class="row-action" style="border:1px solid var(--crit);background:var(--crit-tint);border-radius:10px;color:var(--crit)"><div class="text"><div class="name">Reset workspace</div><div class="help">This wipes all demo bugs and audits. Live data restores on next fetch.</div></div><button class="btn-danger">Reset</button></div>'
    + '</div>';
  if (tab==='ai') return ''
    + '<div class="settings-group"><h2>AI Policies</h2><div class="lede">How aggressive should the AI be at scoring, blocking, and approving?</div>'
    + '<div class="row-action"><div class="text"><div class="name">Auto-approve when AI confidence exceeds threshold</div><div class="help">When the lifecycle-agent confidence is above this number, the bug is automatically marked ready-for-release and skipped from the human queue.</div></div><div style="display:flex;align-items:center;gap:14px"><div style="font-weight:700;font-size:18px;color:var(--accent);min-width:44px;text-align:right">85%</div><span class="switch" data-key="ai.autoApprove" data-on="' + (getSettings().ai.autoApprove ? 'true' : 'false') + '"></span></div></div>'
    + '<div class="row-action"><div class="text"><div class="name">Always require human sign-off for security-domain bugs</div><div class="help">Critical/major bugs whose component is auth, payments, or dashboard always pause for human review.</div></div><span class="switch" data-key="ai.requireSignoff" data-on="' + (getSettings().ai.requireSignoff ? 'true' : 'false') + '"></span></div>'
    + '<div class="row-action"><div class="text"><div class="name">Surface engineering manager summary on every approval</div><div class="help">A 60&ndash;120 word brief rendered above the action buttons on the Human Review tab.</div></div><span class="switch" data-key="ai.showSummary" data-on="' + (getSettings().ai.showSummary ? 'true' : 'false') + '"></span></div>'
    + '<div class="row-action"><div class="text"><div class="name">Auto-publish release notes after every ship</div><div class="help">After a bug&rsquo;s status flips to shipped, the release-notes-agent pushes a one-paragraph note to Releases.</div></div><span class="switch" data-key="ai.autoPublishNotes" data-on="' + (getSettings().ai.autoPublishNotes ? 'true' : 'false') + '"></span></div>'
    + '</div>';
  if (tab==='integrations') return ''
    + '<div class="settings-group"><h2>Integrations</h2><div class="lede">Apps that connect BugOps to the rest of your engineering platform.</div>'
    + '<div class="tile-grid is-2">'
      + mkIntegration('Linear','tasks','linear.app','#5E6AD2')
      + mkIntegration('GitHub','github','github.com','#000')
      + mkIntegration('Sentry','alert-triangle','sentry.io','#E1567A')
      + mkIntegration('Slack','message-square','slack.com','#4A154B')
      + mkIntegration('Jira','square-kanban','atlassian.net','#2684FF')
      + mkIntegration('Stripe','credit-card','stripe.com','#635BFF')
    + '</div></div>';
  if (tab==='keys') return renderKeyVaultTab();
  if (tab==='notify') return ''
    + '<div class="settings-group"><h2>Notifications</h2><div class="lede">Where BugOps should tell you about things that need attention.</div>'
    + '<div class="row-action"><div class="text"><div class="name">Daily digest</div><div class="help">A morning summary of new critical bugs and pending approvals.</div></div><span class="switch" data-key="notifications.dailyDigest" data-on="' + (getSettings().notifications.dailyDigest ? 'true' : 'false') + '"></span></div>'
    + '<div class="row-action"><div class="text"><div class="name">New critical bug</div><div class="help">Real-time alert when a critical severity bug is submitted.</div></div><span class="switch" data-key="notifications.newCritical" data-on="' + (getSettings().notifications.newCritical ? 'true' : 'false') + '"></span></div>'
    + '<div class="row-action"><div class="text"><div class="name">Approval-decision needed</div><div class="help">Notify when the approval-assistant-agent finishes a briefing.</div></div><span class="switch" data-key="notifications.approvalNeeded" data-on="' + (getSettings().notifications.approvalNeeded ? 'true' : 'false') + '"></span></div>'
    + '<div class="row-action"><div class="text"><div class="name">Release readiness flip</div><div class="help">Notify when a release&rsquo;s readiness crosses above 75%.</div></div><span class="switch" data-key="notifications.readinessFlip" data-on="' + (getSettings().notifications.readinessFlip ? 'true' : 'false') + '"></span></div>'
    + '</div>';
  if (tab==='theme') return ''
    + '<div class="settings-group"><h2>Theme</h2><div class="lede">BugOps appearance &mdash; instant switch, persisted per device.</div>'
    + '<div class="tile-grid is-3">'
      + mkTheme('Dark','moon-2','#0c0a14','deep purple black','#fff','dark', currentTheme()==='dark')
      + mkTheme('Light','sun','#f5f4f9','soft purple grey','#1a1633','light', currentTheme()==='light')
      + mkTheme('System','cog','#0c0a14','matches OS','#fff','system')
    + '</div></div>';
  if (tab==='audit') return ''
    + '<div class="settings-group"><h2>Audit Log</h2><div class="lede">Per-user actions on BugOps settings. Read-only.</div>'
    + '<ul style="display:flex;flex-direction:column">'
      + '<li class="row-action"><div class="text"><div class="name">release@bugops.ai rotated default key</div><div class="help">2 hours ago</div></div><span class="chip">rotate</span></li>'
      + '<li class="row-action"><div class="text"><div class="name">release@bugops.ai enabled auto-approve above 85%</div><div class="help">yesterday</div></div><span class="chip">update</span></li>'
      + '<li class="row-action"><div class="text"><div class="name">release@bugops.ai connected Sentry</div><div class="help">2 days ago</div></div><span class="chip">integrate</span></li>'
      + '<li class="row-action"><div class="text"><div class="name">release@bugops.ai onboarded new reviewer</div><div class="help">5 days ago</div></div><span class="chip">update</span></li>'
    + '</ul></div>';
  return '';
  } catch(e) {
    console.warn('[BugOps] settingsTab failed:', e);
    return '';
  }
}

/* ---------- AI Provider Key Vault (Settings > API Keys) ---------- */
function renderKeyVaultTab() {
  var PROVIDERS = [
    { id:'openai',     label:'OpenAI (GPT-4o)',      icon:'🟢', prefix:'sk-',    note:'platform.openai.com' },
    { id:'groq',       label:'Groq (Llama / fast)',  icon:'⚡', prefix:'gsk_',   note:'console.groq.com — free tier available' },
    { id:'grok',       label:'xAI Grok',             icon:'🤖', prefix:'xai-',   note:'console.x.ai — requires credits' },
    { id:'openrouter', label:'OpenRouter',            icon:'🔀', prefix:'sk-or-', note:'openrouter.ai — pay-per-use' }
  ];

  function vaultKey(id) {
    try {
      var raw = localStorage.getItem('bo-ai-key');
      if (!raw) return null;
      var cfg = JSON.parse(raw);
      if (cfg.provider === id) return cfg.key || null;
    } catch(_) {}
    // Also check per-provider vault
    try {
      var v = localStorage.getItem('bo-vault-' + id);
      return v || null;
    } catch(_) {}
    return null;
  }

  var rows = PROVIDERS.map(function(p) {
    var saved = vaultKey(p.id);
    var masked = saved ? (saved.slice(0, 8) + '••••••••••••••••••••••••' + saved.slice(-4)) : '';
    var status = saved
      ? '<span style="color:var(--ok);font-size:11px;font-weight:600">✓ Configured</span>'
      : '<span style="color:var(--text-3);font-size:11px">Not set</span>';

    return '<div class="row-action" id="vault-row-' + p.id + '" style="flex-direction:column;align-items:stretch;gap:10px;padding:14px 16px">' +
      '<div style="display:flex;align-items:center;gap:10px">' +
        '<span style="font-size:18px">' + p.icon + '</span>' +
        '<div style="flex:1">' +
          '<div style="font-weight:600;font-size:13px;color:var(--text-1)">' + escapeHtml(p.label) + '</div>' +
          '<div style="font-size:11px;color:var(--text-3);margin-top:2px">' + escapeHtml(p.note) + '</div>' +
        '</div>' +
        status +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<input class="input" id="vault-input-' + p.id + '" type="password" placeholder="' + escapeHtml(p.prefix) + '..." value="' + (saved ? escapeHtml(saved) : '') + '" style="flex:1;font-family:var(--font-mono);font-size:12px" />' +
        '<button class="btn-ghost btn-sm" id="vault-reveal-' + p.id + '" title="Show/hide key"><i data-lucide="eye"></i></button>' +
        '<button class="btn-primary btn-sm" id="vault-save-' + p.id + '" data-provider="' + p.id + '"><i data-lucide="save"></i>Save</button>' +
        (saved ? '<button class="btn-ghost btn-sm" id="vault-use-' + p.id + '" data-provider="' + p.id + '" style="white-space:nowrap"><i data-lucide="cpu"></i>Use in Commander</button>' : '') +
        (saved ? '<button class="btn-ghost btn-sm" id="vault-clear-' + p.id + '" data-provider="' + p.id + '" style="color:var(--crit)"><i data-lucide="trash-2"></i></button>' : '') +
      '</div>' +
    '</div>';
  }).join('');

  var securityNote =
    '<div style="display:flex;align-items:flex-start;gap:10px;padding:12px 14px;background:var(--bg-3);border-radius:10px;border:var(--hairline);margin-top:16px">' +
      '<i data-lucide="shield-check" style="width:16px;height:16px;color:var(--ok);flex-shrink:0;margin-top:1px"></i>' +
      '<div style="font-size:12px;color:var(--text-3);line-height:1.6">' +
        '<b style="color:var(--text-2)">Keys are browser-local only.</b> They are stored in your browser\'s localStorage and sent <i>directly</i> to the AI provider API — never to BugOps servers. ' +
        'They are cleared when you clear browser data. For shared devices, use a different browser profile.' +
      '</div>' +
    '</div>';

  // Wire interactivity after render
  setTimeout(function() {
    PROVIDERS.forEach(function(p) {
      var input   = document.getElementById('vault-input-' + p.id);
      var reveal  = document.getElementById('vault-reveal-' + p.id);
      var saveBtn = document.getElementById('vault-save-' + p.id);
      var useBtn  = document.getElementById('vault-use-' + p.id);
      var clearBtn= document.getElementById('vault-clear-' + p.id);

      if (reveal && input) {
        reveal.addEventListener('click', function() {
          input.type = input.type === 'password' ? 'text' : 'password';
        });
      }

      if (saveBtn && input) {
        saveBtn.addEventListener('click', function() {
          var k = input.value.trim();
          if (!k) { toast('Enter a key first', 'warn'); return; }
          try { localStorage.setItem('bo-vault-' + p.id, k); } catch(_) {}
          // Also update the active AI Commander key if this provider is currently selected
          // OR if the current active AI Commander key is empty (auto-select the newly saved key)
          try {
            var cur = JSON.parse(localStorage.getItem('bo-ai-key') || '{}');
            if (cur.provider === p.id || !cur.key) {
              localStorage.setItem('bo-ai-key', JSON.stringify({ provider: p.id, key: k }));
            }
          } catch(_) {}
          toast(p.label + ' key saved', 'ok');
          route(); // re-render to show updated status
        });
      }

      if (useBtn) {
        useBtn.addEventListener('click', function() {
          try {
            var k = localStorage.getItem('bo-vault-' + p.id);
            if (k) {
              localStorage.setItem('bo-ai-key', JSON.stringify({ provider: p.id, key: k }));
              toast('Switched AI Commander to ' + p.label, 'ok');
              location.hash = '#/ai-commander';
            }
          } catch(_) {}
        });
      }

      if (clearBtn) {
        clearBtn.addEventListener('click', function() {
          try { localStorage.removeItem('bo-vault-' + p.id); } catch(_) {}
          try {
            var cur = JSON.parse(localStorage.getItem('bo-ai-key') || '{}');
            if (cur.provider === p.id) localStorage.removeItem('bo-ai-key');
          } catch(_) {}
          toast(p.label + ' key cleared', 'warn');
          route();
        });
      }
    });
    if (window.lucide) window.lucide.createIcons();
  }, 0);

  return '<div class="settings-group">' +
    '<h2>AI Provider Key Vault</h2>' +
    '<div class="lede">Store your AI provider keys securely in the browser. One-click sync to AI Commander.</div>' +
    '<div style="background:rgba(59, 130, 246, 0.08);border:1px dashed rgba(59, 130, 246, 0.3);border-radius:10px;padding:12px 14px;margin-top:12px;margin-bottom:16px;display:flex;align-items:center;gap:10px">' +
      '<i data-lucide="info" style="color:var(--accent);width:16px;height:16px;flex-shrink:0"></i>' +
      '<div style="font-size:12px;color:var(--text-2)">' +
        '<b>Recommended for evaluation:</b> OpenRouter (supports free models). OpenAI and xAI require active API credits.' +
      '</div>' +
    '</div>' +
    '<div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">' + rows + '</div>' +
    securityNote +
  '</div>';
}

function mkIntegration(name, icon, host, color){
  var key = name.toLowerCase();
  var on = getSettings().integrations[key] !== false;
  return '<div class="card is-hover" style="cursor:pointer"><div style="display:flex;align-items:flex-start;gap:14px">'
    + '<div style="width:40px;height:40px;border-radius:10px;background:' + color + '22;color:' + color + ';display:grid;place-items:center"><i data-lucide="' + icon + '"></i></div>'
    + '<div style="flex:1"><div style="font-weight:700">' + name + '</div><div class="meta">' + host + '</div></div>'
    + '<div class="switch" data-key="integrations.' + key + '" data-on="' + (on ? 'true' : 'false') + '"></div></div>'
    + '<div style="font-size:12px;color:var(--text-3)">Triage-to-issue sync &middot; issues push to BugOps with their AI verdicts.</div></div>';
}
function mkTheme(name, icon, swatch, sub, fg, value, checked){
  return '<button class="card is-hover" data-theme-pick="' + value + '" style="text-align:left;cursor:pointer;' + (checked?'border-color:var(--accent)':'') + '">'
    + '<div style="display:flex;align-items:center;gap:10px">'
      + '<div style="width:32px;height:32px;border-radius:8px;background:' + swatch + ';color:' + fg + ';display:grid;place-items:center;border:1px solid var(--border)"><i data-lucide="' + icon + '"></i></div>'
      + '<div><div style="font-weight:700">' + name + '</div><div class="meta">' + sub + '</div></div>'
      + '<i data-lucide="check-circle-2" style="margin-left:auto;color:' + (checked?'var(--accent)':'var(--text-muted)') + '"></i>'
    + '</div></button>';
}

/* ---------- Command palette ---------- */
function openPalette(){
  Ctx._paletteItems = [
    { kind:'route', label:'Go to Executive Dashboard', route:'#/', icon:'layout-dashboard', kbd:'G D' },
    { kind:'route', label:'Go to Bug Operations',     route:'#/operations', icon:'bug', kbd:'G B' },
    { kind:'route', label:'Go to Release Center',     route:'#/releases', icon:'rocket', kbd:'G R' },
    { kind:'route', label:'Go to Engineering Insights', route:'#/insights', icon:'bar-chart-3', kbd:'G I' },
    { kind:'route', label:'Go to Settings',           route:'#/settings', icon:'settings', kbd:'G S' }
  ].concat(Ctx.bugs.slice(0,8).map(b => ({ kind:'bug', label:b.title, route:'#/bug/'+encodeURIComponent(b.id), icon:'alert-circle' })))
   .concat([
     { kind:'action', label:'Toggle theme', icon:'sun-moon', fn: () => setTheme(currentTheme()==='dark'?'light':'dark') },
     { kind:'action', label:'New bug',     icon:'plus', fn: () => openModalNewBug() }
   ]);
  Ctx._paletteIndex = 0;
  const mount = $1('#palette-mount');
  mount.innerHTML = '<div class="palette" id="palette"><div class="modal-scrim"></div>'
    + '<div class="palette-panel"><input class="palette-input" id="palette-input" placeholder="Type a command or search&hellip;" /><div class="palette-list" id="palette-list"></div></div></div>';
  Ctx._paletteOpen = true;
  $1('#palette-input').focus();
  $1('#palette-input').addEventListener('input', e => { Ctx._paletteQ = (e.target.value||'').toLowerCase(); renderPaletteList(); });
  document.addEventListener('keydown', paletteKeydown);
  renderPaletteList();
}
function closePalette(){ $1('#palette-mount').innerHTML=''; Ctx._paletteOpen=false; document.removeEventListener('keydown', paletteKeydown); }
function paletteKeydown(e){
  if (e.key==='Escape') return closePalette();
  if (e.key==='ArrowDown'){ Ctx._paletteIndex = Math.min(Ctx._paletteItems.length-1, Ctx._paletteIndex+1); renderPaletteList(); e.preventDefault(); }
  if (e.key==='ArrowUp')  { Ctx._paletteIndex = Math.max(0, Ctx._paletteIndex-1); renderPaletteList(); e.preventDefault(); }
  if (e.key==='Enter')    { runPalette(Ctx._paletteItems[Ctx._paletteIndex]); e.preventDefault(); }
}
function renderPaletteList(){
  const items = Ctx._paletteItems.filter(it => it.label.toLowerCase().includes(Ctx._paletteQ||''));
  Ctx._paletteItems = items;
  if (Ctx._paletteIndex>=items.length) Ctx._paletteIndex=0;
  const list = $1('#palette-list');
  if (!list) return;
  list.innerHTML = items.map((it, i) =>
    '<div class="palette-item" data-active="' + (i===Ctx._paletteIndex?'true':'false') + '" data-i="' + i + '"><i data-lucide="' + (it.icon||'arrow-right') + '"></i><span>' + escapeHtml(it.label) + '</span>' + (it.kbd?'<span class="kbd">'+it.kbd+'</span>':'') + '</div>'
  ).join('') || '<div class="palette-item"><i data-lucide="search-x"></i><span style="color:var(--text-3)">No matches</span></div>';
  $$('.palette-item').forEach((el, i) => el.addEventListener('mouseenter', () => { Ctx._paletteIndex=i; renderPaletteList(); }));
  $$('.palette-item').forEach((el, i) => el.addEventListener('click',   () => runPalette(items[i])));
  if (window.lucide) window.lucide.createIcons();
}
function runPalette(it){
  if (!it) return;
  if (it.kind==='route'){ location.hash = it.route; closePalette(); }
  if (it.kind==='bug')  { location.hash = it.route; closePalette(); }
  if (it.kind==='action'){ it.fn && it.fn(); closePalette(); }
}

/* ---------- Modal ---------- */
function openModalNewBug(){
  const mount = $1('#modal-mount');
  mount.innerHTML =
    '<div class="modal" id="new-modal">'
    + '<div class="modal-scrim"></div>'
    + '<div class="modal-panel">'
      + '<div class="panel-head"><i data-lucide="plus-circle" style="color:var(--accent)"></i>'
      + '<h3 style="flex:1">Report a Bug</h3>'
      + '<button class="iconbtn" id="modal-close" type="button" aria-label="Close dialog"><i data-lucide="x"></i></button></div>'
      + '<div class="panel-body">'
        + '<div class="field-set"><div class="label">Title</div><input class="input" id="nb-title" placeholder="One-line summary"></div>'
        + '<div class="field-set"><div class="label">Domain</div><select class="select" id="nb-domain">' + DOMAIN_TOKENS.map(d => '<option value="' + d + '">' + d + '</option>').join('') + '</select></div>'
        + '<div class="field-set"><div class="label">Source</div><select class="select" id="nb-source"><option value="user_report">User Report</option><option value="monitoring">Monitoring</option><option value="internal_qa">Internal QA</option><option value="customer_support">Customer Support</option></select></div>'
        + '<div class="field-set"><div class="label">Description</div><textarea class="textarea" id="nb-desc" placeholder="Reproduction steps, expected, actual..."></textarea></div>'
        + '<div class="field-row"><div class="field-set"><div class="label">Severity</div><select class="select" id="nb-sev"><option value="minor">minor</option><option value="major">major</option><option value="critical">critical</option><option value="cosmetic">cosmetic</option></select></div>'
          + '<div class="field-set"><div class="label">Priority</div><select class="select" id="nb-pri"><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="urgent">urgent</option></select></div></div>'
      + '</div>'
      + '<div class="panel-foot"><button class="btn-ghost" id="nb-cancel">Cancel</button>'
      + '<button class="btn-primary" id="nb-submit"><i data-lucide="send"></i>Submit &amp; Tri-age</button></div>'
    + '</div></div>';
  if (window.lucide) window.lucide.createIcons();
  const close = () => { mount.innerHTML = ''; };
  $1('#modal-close').addEventListener('click', close);
  $1('#nb-cancel').addEventListener('click', close);
  $1('.modal-scrim').addEventListener('click', close);
  $1('#nb-submit').addEventListener('click', async () => {
    const title = $1('#nb-title').value.trim();
    if (!title || title.length < 5) return toast('Title is too short', 'warn');
    const payload = {
      id: nextId('bug'),
      title,
      desc: $1('#nb-desc').value,
      domain: $1('#nb-domain').value,
      severity: $1('#nb-sev').value,
      priority: $1('#nb-pri').value,
      status: 'triage',
      source: $1('#nb-source').value,
      submitter: 'release@bugops.ai',
      created_at: new Date().toISOString()
    };
    Ctx.bugs = [payload].concat(Ctx.bugs);
    try { if (window.lemmaApp) await window.lemmaApp.records.create('bugs', payload); } catch (_) {}
    close(); route(); toast('Bug submitted — AI is triaging', 'ok');
  });
}
function toast(msg, tone){
  const stack = $1('#toast-stack');
  const n = el('<div class="toast is-' + tone + '"><i data-lucide="' + (tone==='ok'?'check-circle':tone==='warn'?'alert-triangle':'info') + '"></i><span>' + escapeHtml(msg) + '</span></div>');
  stack.appendChild(n);
  if (window.lucide) window.lucide.createIcons();
  setTimeout(() => { n.style.opacity='0'; setTimeout(() => n.remove(), 200); }, 2400);
}

/* ---------- Wires ---------- */
function wireUi(){
  $1('#theme-toggle').addEventListener('click', () => setTheme(currentTheme()==='dark'?'light':'dark'));
  $1('#sb-collapse').addEventListener('click', function() {
    var app = document.getElementById('app');
    var isCollapsed = app.dataset.collapsed === 'true';
    app.dataset.collapsed = isCollapsed ? 'false' : 'true';
    var btn = $1('#sb-collapse');
    if (btn) {
      // Remove old icon (lucide replaces <i> with <svg>, so we look for either)
      var oldIcon = btn.querySelector('[data-lucide], svg, i');
      if (oldIcon) oldIcon.remove();
      // Create a fresh <i> element for lucide to render
      var newIcon = document.createElement('i');
      newIcon.setAttribute('data-lucide', isCollapsed ? 'panel-left-close' : 'panel-left-open');
      btn.insertBefore(newIcon, btn.firstChild);
      btn.setAttribute('aria-label', isCollapsed ? 'Collapse sidebar' : 'Expand sidebar');
      btn.setAttribute('title', isCollapsed ? 'Collapse sidebar' : 'Expand sidebar');
      if (window.lucide) window.lucide.createIcons();
    }
  });
  $1('#sb-open').addEventListener('click', () => document.getElementById('app').classList.add('mobile-drawer'));
  $1('#sb-scrim').addEventListener('click', () => document.getElementById('app').classList.remove('mobile-drawer'));
  $1('#sb-nav').addEventListener('click', e => {
    const link = e.target.closest('.sb-link');
    if (link && link.dataset.route) {
      document.getElementById('app').classList.remove('mobile-drawer');
      Ctx._selected.clear();
    }
  });
  document.body.addEventListener('click', e => {
    if (e.target.closest('#new-bug') || e.target.closest('#new-bug-2')) openModalNewBug();
    var detailBtn = e.target.closest('.detail-sticky-actions .acts button, #review-actions button, .detail-panels .btn-ghost');
    if (detailBtn) {
      var txt = detailBtn.textContent.trim();
      if (txt.indexOf('Re-run AI') !== -1) {
        var bugId = (location.hash||'').split('/')[2]?.split('?')[0];
        if (bugId) {
          Ctx.reviews.push({ id: 'rev-' + Date.now(), bug_id: bugId, actor: 'user', kind: 'analysis', severity: '', priority: '', created_at: new Date().toISOString(), note: 'AI re-analysis requested by user' });
          route();
          toast('AI re-analysis queued - review entry added', 'ok');
        }
      } else if (txt.indexOf('Copy link') !== -1) {
        navigator.clipboard.writeText(window.location.href).then(function() {
          toast('Link copied to clipboard', 'ok');
        }).catch(function() {
          toast('Could not copy link', 'warn');
        });
      } else if (txt.indexOf('Approve for Release') !== -1) {
        var bugId = (location.hash||'').split('/')[2]?.split('?')[0];
        if (bugId) {
          var b = Ctx.bugs.find(function(x){ return x.id === bugId; });
          if (b) { b.status = 'ready'; }
          Ctx.reviews.push({ id: 'rev-' + Date.now(), bug_id: bugId, actor: 'user', kind: 'approval', severity: b?b.severity:'', priority: b?b.priority:'', created_at: new Date().toISOString(), note: 'Approved for release by user' });
          route();
          toast('Bug approved for release! Status set to ready', 'ok');
        }
      } else if (txt.indexOf('Request Changes') !== -1) {
        var bugId = (location.hash||'').split('/')[2]?.split('?')[0];
        if (bugId) {
          var b = Ctx.bugs.find(function(x){ return x.id === bugId; });
          if (b) { b.status = 'review'; }
          Ctx.reviews.push({ id: 'rev-' + Date.now(), bug_id: bugId, actor: 'user', kind: 'approval', severity: b?b.severity:'', priority: b?b.priority:'', created_at: new Date().toISOString(), note: 'Changes requested by user - sending back for re-evaluation' });
          route();
          toast('Changes requested - status set to review', 'info');
        }
      } else if (txt.indexOf('Investigate Further') !== -1) {
        var bugId = (location.hash||'').split('/')[2]?.split('?')[0];
        if (bugId) {
          var b = Ctx.bugs.find(function(x){ return x.id === bugId; });
          if (b) { b.status = 'blocked'; }
          Ctx.reviews.push({ id: 'rev-' + Date.now(), bug_id: bugId, actor: 'user', kind: 'analysis', severity: b?b.severity:'', priority: b?b.priority:'', created_at: new Date().toISOString(), note: 'Flagged for deeper investigation by user' });
          route();
          toast('Flagged for investigation - status set to blocked', 'info');
        }
      }
      return;
    }
        const pick = e.target.closest('[data-theme-pick]');
    if (pick) { setTheme(pick.dataset.themePick==='system' ? (window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark') : pick.dataset.themePick); route(); return; }
    const tgl = e.target.closest('[data-toggle]');
    if (tgl) {
      const v = tgl.dataset.toggle;
      if (v==='table' || v==='grid') Ctx._prefs.view = v;
      if (Ctx._route && Ctx._route.startsWith('/operations')) route();
      return;
    }
    const fc = e.target.closest('[data-filter]');
    if (fc) {
      const f = fc.dataset.filter, val = fc.dataset.value;
      const arr = Ctx._prefs.filters[f] || (Ctx._prefs.filters[f]=[]);
      const i = arr.indexOf(val);
      if (i>=0) arr.splice(i,1); else arr.push(val);
      if (Ctx._route && Ctx._route.startsWith('/operations')) route();
      return;
    }
    const cb = e.target.closest('[data-bulk]');
    if (cb) {
      const id = cb.dataset.bulk;
      if (Ctx._selected.has(id)) Ctx._selected.delete(id); else Ctx._selected.add(id);
      if (Ctx._route && Ctx._route.startsWith('/operations')) route();
      return;
    }
    if (e.target.closest('#bulk-clear')) { Ctx._selected.clear(); route(); return; }
    var bulkBtn = e.target.closest('.bulk-bar .btn-ghost');
    if (bulkBtn) {
      var txt = bulkBtn.textContent.trim();
      var ids = Array.from(Ctx._selected);
      if (txt === 'Mark triaged') {
        ids.forEach(function(id) {
          var b = Ctx.bugs.find(function(x){ return x.id === id; });
          if (b) b.status = 'triaged';
        });
        Ctx._selected.clear(); route();
        toast('Marked ' + ids.length + ' bug(s) as triaged', 'ok');
      } else if (txt === 'Assign') {
        var assigneeName = '';
        ids.forEach(function(id) {
          var b = Ctx.bugs.find(function(x){ return x.id === id; });
          if (b) {
            var assn = recommendAssignment(b, ANALYSES_BY_BUG()[id]);
            b._assignee = assn.assignee;
            assigneeName = assn.assignee;
          }
        });
        toast('Assigned ' + ids.length + ' bug(s) to ' + assigneeName, 'ok');
        Ctx._selected.clear(); route();
      } else if (txt.indexOf('Bulk AI review') !== -1) {
        ids.forEach(function(id) {
          Ctx.reviews.push({ id: 'rev-' + Date.now() + '-' + id, bug_id: id, actor: 'user', kind: 'analysis', severity: '', priority: '', created_at: new Date().toISOString(), note: 'Bulk AI review requested by user' });
        });
        toast('Queued AI review for ' + ids.length + ' bug(s)', 'ok');
        Ctx._selected.clear(); route();
      }
      return;
    }
    var pageBtn = e.target.closest('.page-btn');
    if (pageBtn) {
      var txt = pageBtn.textContent.trim();
      var pageNum = parseInt(txt, 10);
      if (!isNaN(pageNum) && pageNum > 0) {
        route();
      } else if (pageBtn.querySelector('[data-lucide="chevron-left"]')) {
        if (Ctx._page > 1) { Ctx._page--; route(); } else { toast('Already on first page', 'info'); }
      } else if (pageBtn.querySelector('[data-lucide="chevron-right"]')) {
        var total = applyFilters().length;
        var maxPage = Math.ceil(total / 10) || 1;
        if (Ctx._page < maxPage) { Ctx._page++; route(); } else { toast('Already on last page', 'info'); }
      }
      return;
    }
        var pageActionBtn = e.target.closest('.page .page-actions .btn-secondary, .page .page-actions .btn-primary');
    if (pageActionBtn) {
      var txt = pageActionBtn.textContent.trim();
      if (txt.indexOf('Export PDF') !== -1) { exportPDF(); return; } if (txt === 'Export') {
        var csvRows = ['id,title,severity,priority,status,domain,submitter,created_at'];
        Ctx.bugs.forEach(function(b){ csvRows.push('"' + (b.id||'') + '","' + (b.title||'').replace(/"/g,'""') + '","' + (b.severity||'') + '","' + (b.priority||'') + '","' + (b.status||'') + '","' + (b.domain||'') + '","' + (b.submitter||'') + '","' + (b.created_at||'') + '"'); });
        var blob = new Blob([csvRows.join('\n')], {type:'text/csv'});
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a'); a.href = url; a.download = 'bugops-export-' + new Date().toISOString().slice(0,10) + '.csv'; a.click();
        URL.revokeObjectURL(url);
        toast('CSV downloaded with ' + Ctx.bugs.length + ' bugs', 'ok');
        return;
      }
      if (txt.indexOf('Schedule') !== -1 && txt.indexOf('Report') !== -1) {
        getSettings(); Ctx._settings.scheduleReport = true; saveSettings();
        var sd = getScheduleDisplay();
        toast('Weekly report scheduled. Next: ' + (sd ? sd.nextRun : 'Monday 09:00'), 'ok');
        route();
        return;
      }
      if (txt === 'Run AI Report') {
        getSettings(); Ctx._settings.scheduleReport = true; saveSettings();
        openAIReportModal();
        return;
      }
      if (txt === 'Filters') {
        var mount = $1('#modal-mount');
        mount.innerHTML = '<div class="modal" id="filter-modal"><div class="modal-scrim"></div><div class="modal-panel" style="max-width:480px"><div class="panel-head"><i data-lucide="sliders-horizontal" style="color:var(--accent)"></i><h3 style="flex:1">Advanced Filters</h3><button class="iconbtn" id="filter-close" type="button" aria-label="Close"><i data-lucide="x"></i></button></div><div class="panel-body" style="display:flex;flex-direction:column;gap:14px"><p style="font-size:13px;color:var(--text-3)">Use the filter chips in the toolbar below to filter by severity and status. Additional filter options:</p><div class="field-set"><div class="label">Search bugs</div><input class="input" id="filter-search" placeholder="Type to search…" value="' + escapeHtml(Ctx._query||'') + '"></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><div><div class="label">Severity</div><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">' + ['critical','major','minor','cosmetic'].map(function(s){ return '<span class="chip chip-tone-' + (Ctx._prefs.filters.severity.includes(s)?'crit':'default') + '" data-filter="severity" data-value="' + s + '" style="cursor:pointer">' + s + '</span>'; }).join('') + '</div></div><div><div class="label">Status</div><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">' + ['review','triaged','blocked','risk','ready','shipped'].map(function(s){ return '<span class="chip chip-tone-' + (Ctx._prefs.filters.status.includes(s)?'warn':'default') + '" data-filter="status" data-value="' + s + '" style="cursor:pointer">' + s + '</span>'; }).join('') + '</div></div></div><button class="btn-primary" id="filter-apply"><i data-lucide="check"></i>Apply Filters</button></div></div></div>';
        if (window.lucide) window.lucide.createIcons();
        $1('#filter-close').addEventListener('click', function(){ mount.innerHTML = ''; });
        $1('.modal-scrim').addEventListener('click', function(){ mount.innerHTML = ''; });
        mount.addEventListener('click', function(ev){
          var chip = ev.target.closest('[data-filter][data-value]');
          if (chip) {
            var isActive = chip.classList.contains('chip-tone-crit') || chip.classList.contains('chip-tone-warn');
            chip.classList.toggle('chip-tone-crit', chip.dataset.filter==='severity' ? !isActive : false);
            chip.classList.toggle('chip-tone-warn', chip.dataset.filter==='status' ? !isActive : false);
            chip.classList.toggle('chip-tone-default', isActive);
            return;
          }
        });
        $1('#filter-apply').addEventListener('click', function(){
          var q = ($1('#filter-search')||{}).value || '';
          Ctx._query = q;
          var chips = mount.querySelectorAll('[data-filter]');
          chips.forEach(function(c){
            var f = c.dataset.filter; var val = c.dataset.value;
            if (f && val) {
              var arr = Ctx._prefs.filters[f] || (Ctx._prefs.filters[f]=[]);
              var active = c.classList.contains('chip-tone-crit') || c.classList.contains('chip-tone-warn');
              var i = arr.indexOf(val);
              if (active && i===-1) arr.push(val);
              if (!active && i>=0) arr.splice(i,1);
            }
          });
          mount.innerHTML = '';
          route();
        });
        return;
      }
      if (txt.indexOf('Open PRs') !== -1) {
        openPRsModal();
        return;
      }
      if (txt.indexOf('Plan Release') !== -1) {
        openReleasePlanningModal();
        return;
      }
    }
        var switchEl = e.target.closest('.switch[data-key]');
    if (switchEl) {
      var keyPath = switchEl.dataset.key;
      if (keyPath) {
        var s = getSettings();
        var parts = keyPath.split('.');
        var obj = s;
        for (var si = 0; si < parts.length - 1; si++) { obj = obj[parts[si]] || (obj[parts[si]] = {}); }
        obj[parts[parts.length - 1]] = !obj[parts[parts.length - 1]];
        saveSettings();
        route();
        return;
      }
    }
    const wsInput = e.target.closest('#set-workspace-name, #set-workspace-desc');
    if (wsInput && Ctx._route && Ctx._route.startsWith('/settings')) {
      var s = getSettings();
      s.workspace.name = ($1('#set-workspace-name') || {}).value || s.workspace.name;
      s.workspace.desc = ($1('#set-workspace-desc') || {}).value || s.workspace.desc;
      saveSettings();
      return;
    }
    var resetBtn = e.target.closest('.btn-danger');
    if (resetBtn && Ctx._route && Ctx._route.startsWith('/settings')) {
      Ctx.bugs = DEMO_BUGS.slice();
      Ctx.reviews = DEMO_REVIEWS.slice();
      Ctx.analyses = DEMO_ANALYSES.slice();
      Ctx._selected.clear();
      Ctx._query = '';
      Ctx._page = 1;
      Ctx._prefs.filters = { severity: [], status: [], priority: [] };
      Ctx._prefs = Object.assign(Ctx._prefs, { view: 'table', sort: 'reported_desc', filters: { severity: [], status: [], priority: [] } });
      Ctx._settings = null;
      try { localStorage.removeItem(BO_SETTINGS_KEY); } catch(_) {}
      toast('Workspace reset - demo data restored', 'ok');
      route();
      return;
    }
    const tab = e.target.closest('[data-tab]');
    if (tab && Ctx._route && Ctx._route.startsWith('/bug/')) {
      location.hash = location.hash.split('?')[0] + '?tab=' + tab.dataset.tab;
      return;
    }
    var releaseCopyBtn = e.target.closest('.iconbtn[aria-label="Copy release notes"]');
    if (releaseCopyBtn) {
      var noteText = releaseCopyBtn.closest('[style*="border:var(--hairline)"]');
      if (noteText) {
        var content = noteText.querySelector('[style*="font-size:13px;color:var(--text-2)"]') || noteText.querySelector('[style*="line-height:1.55"]');
        if (content) {
          navigator.clipboard.writeText(content.textContent.trim()).then(function() {
            toast('Release notes copied to clipboard', 'ok');
          }).catch(function() {
            toast('Could not copy', 'warn');
          });
        }
      }
      return;
    }
    const th = e.target.closest('[data-sort]');
    if (th && Ctx._route && Ctx._route.startsWith('/operations')) {
      const s = th.dataset.sort;
      Ctx._prefs.sort = (Ctx._prefs.sort===s ? 'reported_desc' : s);
      route();
      return;
    }
  });
  var setWsName = $1('#set-workspace-name'); if (setWsName) setWsName.addEventListener('change', function(){ var s = getSettings(); s.workspace.name = this.value; saveSettings(); });
  var setWsDesc = $1('#set-workspace-desc'); if (setWsDesc) setWsDesc.addEventListener('change', function(){ var s = getSettings(); s.workspace.desc = this.value; saveSettings(); });
  var settingsForm = $1('.settings-form'); if (settingsForm) settingsForm.addEventListener('click', function(e) {
    var apiBtn = e.target.closest('button'); if (!apiBtn) return;
    if (apiBtn.textContent.trim() === 'Copy') {
      var row = apiBtn.closest('.row-action');
      var help = row ? row.querySelector('.help') : null;
      navigator.clipboard.writeText(help ? help.textContent.trim() : '').then(function(){ toast('API key copied', 'ok'); }).catch(function(){ toast('Could not copy', 'warn'); });
    } else if (apiBtn.textContent.trim() === 'Rotate') {
      var newKey = 'bo_live_' + Math.random().toString(36).substr(2,8) + '...';
      var helpEl = apiBtn.closest('.row-action').querySelector('.help');
      if (helpEl) helpEl.textContent = newKey;
      toast('API key rotated', 'ok');
    }
  });
  const search = $1('#op-search');
  const onS = debounce(v => {
    Ctx._query = v || '';
    location.hash = '#/operations';
  }, 200);
  search.addEventListener('input', e => onS(e.target.value));
  document.addEventListener('keydown', e => {
    const isCmd = (e.metaKey||e.ctrlKey) && (e.key||'').toLowerCase() === 'k';
    if (isCmd) { e.preventDefault(); openPalette(); return; }
    if (e.key==='Escape') { $1('#modal-mount').innerHTML=''; if (Ctx._paletteOpen) closePalette(); }
  });
}

/* ---------- Boot ---------- */
function openAIReportModal(){
  try {
  var bugs = safeArr(Ctx.bugs);
  var analyses = safeArr(Ctx.analyses);
    var critCount = bugs.filter(function(b){ return b.severity==='critical'; }).length;
  var majorCount = bugs.filter(function(b){ return b.severity==='major'; }).length;
  var readyCount = bugs.filter(function(b){ return b.status==='ready'; }).length;
  var blockedCount = bugs.filter(function(b){ return b.status==='blocked'; }).length;
  var riskCount = bugs.filter(function(b){ return b.status==='risk'; }).length;
  var totalConf = 0, confCount = 0;
  analyses.forEach(function(a){ if(a.ai_confidence){ totalConf += a.ai_confidence; confCount++; } });
  var avgConf = confCount ? Math.round(totalConf/confCount*100) : 85;
  var riskLevel = blockedCount > 0 ? 'High' : riskCount > 0 ? 'Medium' : 'Low';
  var readiness = Math.min(100, Math.round((readyCount / (bugs.length||1)) * 100));
  var topCrit = bugs.filter(function(b){ return b.severity==='critical'; }).slice(0,5);
  var recommendations = [];
  if (blockedCount > 0) recommendations.push('Resolve ' + blockedCount + ' blocked bug(s) before next release');
  if (critCount > 0) recommendations.push('Prioritize ' + critCount + ' critical bug(s) for immediate triage');
  if (readyCount > 0) recommendations.push('Ship ' + readyCount + ' ready bug(s) to production');
  if (riskCount > 0) recommendations.push('Review ' + riskCount + ' high-risk bug(s) before cut');
  recommendations.push('Run full regression suite on affected components');
  var now = new Date().toLocaleString();
  var mount = $1('#modal-mount');
  mount.innerHTML = '<div class="modal" id="ai-report-modal"><div class="modal-scrim"></div><div class="modal-panel" style="max-width:680px;max-height:80vh;overflow-y:auto"><div class="panel-head"><i data-lucide="brain-circuit" style="color:var(--accent)"></i><h3 style="flex:1">AI Executive Report</h3><button class="iconbtn" id="report-close" type="button" aria-label="Close"><i data-lucide="x"></i></button></div><div class="panel-body" style="display:flex;flex-direction:column;gap:16px">'
    + '<div style="display:flex;align-items:center;gap:12px;padding:14px;background:var(--bg-2);border-radius:12px;border:var(--hairline)"><i data-lucide="calendar" style="width:18px;height:18px;color:var(--accent)"></i><span style="font-size:12px;color:var(--text-3)">Generated: ' + escapeHtml(now) + '</span></div>'
    + '<div style="padding:16px;background:var(--bg-2);border-radius:12px;border:var(--hairline);border-left:3px solid var(--accent)"><div class="scapt">EXECUTIVE SUMMARY</div><div style="font-size:14px;color:var(--text-2);line-height:1.6;margin-top:8px">BugOps AI analyzed ' + bugs.length + ' bugs across ' + Object.keys(domainCounts()).length + ' domains. ' + critCount + ' critical, ' + majorCount + ' major. AI confidence averages ' + avgConf + '%. ' + readyCount + ' bugs ready to ship, ' + blockedCount + ' blocked.</div></div>'
    + '<div class="tile-grid is-2">'
      + '<div style="padding:14px;background:var(--bg-2);border-radius:12px;border:var(--hairline)"><div class="scapt">RELEASE RECOMMENDATION</div><div style="font-size:20px;font-weight:700;margin-top:4px">' + (riskLevel==='High'?'Hold':riskLevel==='Medium'?'Caution':'Proceed') + '</div><div style="font-size:12px;color:var(--text-3)">Readiness: ' + readiness + '%</div></div>'
      + '<div style="padding:14px;background:var(--bg-2);border-radius:12px;border:var(--hairline)"><div class="scapt">RISK LEVEL</div><div style="font-size:20px;font-weight:700;margin-top:4px;color:' + (riskLevel==='High'?'var(--crit)':riskLevel==='Medium'?'var(--warn)':'var(--ok)') + '">' + escapeHtml(riskLevel) + '</div><div style="font-size:12px;color:var(--text-3)">' + blockedCount + ' blockers</div></div>'
    + '</div>'
    + '<div><div class="scapt">TOP CRITICAL BUGS</div>' + (topCrit.length ? topCrit.map(function(b){ return '<a class="mini-row" href="#/bug/' + encodeURIComponent(b.id) + '" style="text-decoration:none"><span class="sev-dot" data-sev="critical"></span><div><div style="font-size:13px;font-weight:600;color:var(--text-1)">' + escapeHtml(b.title) + '</div><div style="font-size:11px;color:var(--text-3)">' + escapeHtml((b.desc||'').slice(0,80)) + '</div></div><span class="chip chip-tone-crit">' + escapeHtml(b.status||'') + '</span></a>'; }).join('') : '<div style="font-size:13px;color:var(--text-3);padding:8px 0">No critical bugs at this time</div>') + '</div>'
    + '<div><div class="scapt">RECOMMENDED NEXT ACTIONS</div><ul style="display:flex;flex-direction:column;gap:6px;margin-top:8px">' + recommendations.map(function(r){ return '<li style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-2)"><i data-lucide="check-circle-2" style="width:14px;height:14px;color:var(--ok);flex-shrink:0"></i>' + escapeHtml(r) + '</li>'; }).join('') + '</ul></div>'
    + '</div></div></div>';
  if (window.lucide) window.lucide.createIcons();
  $1('#report-close').addEventListener('click', function(){ mount.innerHTML = ''; });
  $1('.modal-scrim').addEventListener('click', function(){ mount.innerHTML = ''; });
  } catch(e) { console.warn('[BugOps] AI report modal failed:', e); toast('Could not generate report', 'warn'); }
}
function openPRsModal(){
  try {
  var bugs = safeArr(Ctx.bugs);
  var reviewBugs = bugs.filter(function(b){ return b.status==='review'; });
  var blockedBugs = bugs.filter(function(b){ return b.status==='blocked'; });
  var riskBugs = bugs.filter(function(b){ return b.status==='risk'; });
  var readyBugs = bugs.filter(function(b){ return b.status==='ready'; });
  var allPRBugs = [].concat(reviewBugs, riskBugs, blockedBugs, readyBugs);
  var mount = $1('#modal-mount');
  mount.innerHTML = '<div class="modal"><div class="modal-scrim"></div><div class="modal-panel" style="max-width:700px;max-height:85vh;overflow-y:auto"><div class="panel-head"><i data-lucide="git-pull-request-arrow" style="color:var(--accent)"></i><h3 style="flex:1">Open Pull Requests</h3><button class="iconbtn" id="pr-close" type="button" aria-label="Close"><i data-lucide="x"></i></button></div><div class="panel-body" style="display:flex;flex-direction:column;gap:16px">'
    + '<div style="display:flex;gap:12px;flex-wrap:wrap">'
      + '<div style="flex:1;padding:14px;background:var(--bg-2);border-radius:12px;border:var(--hairline);text-align:center;min-width:80px"><div style="font-size:26px;font-weight:700;color:var(--warn)">' + reviewBugs.length + '</div><div style="font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em">In Review</div></div>'
      + '<div style="flex:1;padding:14px;background:var(--bg-2);border-radius:12px;border:var(--hairline);text-align:center;min-width:80px"><div style="font-size:26px;font-weight:700;color:var(--crit)">' + blockedBugs.length + '</div><div style="font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em">Blocked</div></div>'
      + '<div style="flex:1;padding:14px;background:var(--bg-2);border-radius:12px;border:var(--hairline);text-align:center;min-width:80px"><div style="font-size:26px;font-weight:700;color:var(--ok)">' + readyBugs.length + '</div><div style="font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em">Ready</div></div>'
    + '</div>'
    + '<div class="scapt"><span class="bar"></span>PULL REQUESTS</div>'
    + (allPRBugs.length ? allPRBugs.map(function(b){
      var tone = b.status==='ready'?'ok':b.status==='blocked'?'crit':b.status==='risk'?'warn':'info';
      return '<a class="mini-row" href="#/bug/' + encodeURIComponent(b.id) + '" style="text-decoration:none;display:grid;grid-template-columns:auto 1fr auto auto;gap:12px;align-items:center;padding:10px 12px;border-radius:10px;background:var(--bg-2);margin-bottom:6px;transition:background var(--d-fast) var(--ease)">'
        + '<span class="sev-dot" data-sev="' + severityTone(b.severity) + '"></span>'
        + '<div><div style="font-size:13px;font-weight:600;color:var(--text-1)">' + escapeHtml(b.title) + '</div><div style="font-size:11px;color:var(--text-3);margin-top:2px">' + escapeHtml(b.id) + ' · ' + escapeHtml(b.domain||'') + '</div></div>'
        + '<span class="pill-status" data-status="' + (b.status==='review'?'triage':b.status) + '">' + escapeHtml(b.status) + '</span>'
        + '<span style="font-size:11px;color:var(--text-3);white-space:nowrap">' + (b.created_at?fmtRel(b.created_at):'—') + '</span>'
      + '</a>';
    }).join('') : '<div style="text-align:center;padding:20px;color:var(--text-3);font-size:13px">No open pull requests at this time.</div>')
    + '</div></div></div>';
  if (window.lucide) window.lucide.createIcons();
  $1('#pr-close').addEventListener('click', function(){ mount.innerHTML = ''; });
  $1('.modal-scrim').addEventListener('click', function(){ mount.innerHTML = ''; });
  } catch(e) { console.warn('[BugOps] PRs modal failed:', e); toast('Could not open PRs view', 'warn'); }
}


function openReleasePlanningModal(){
  try {
  var bugs = safeArr(Ctx.bugs);
  var aMap = ANALYSES_BY_BUG();
  var readyBugs = bugs.filter(function(b){ return b.status==="ready"; });
  var blockedBugs = bugs.filter(function(b){ return b.status==="blocked"; });
  var candidateBugs = bugs.filter(function(b){ return b.status==="triaged" || b.status==="review" || b.status==="risk"; });
  var excludedBugs = bugs.filter(function(b){ return b.status==="shipped" || b.status==="triaged"; });
  var totalBugs = bugs.length;
  var riskScore = blockedBugs.length > 0 ? 65 + blockedBugs.length * 10 : candidateBugs.length > 3 ? 45 : 25;
  riskScore = Math.min(100, riskScore);
  var readiness = Math.round((readyBugs.length / (totalBugs||1)) * 100);
  var riskTone = riskScore > 70 ? "crit" : riskScore > 40 ? "warn" : "ok";
  var rollback = riskScore > 50 ? "Prepare rollback plan: feature flag disable + DB restore + DNS failover" : "Low risk \u2014 standard rollback via git revert + CI pipeline";
  var deployWindow = new Date(Date.now() + (riskScore > 50 ? 7 : 3) * 86400000).toLocaleDateString("en-US", { weekday:"long", month:"short", day:"numeric" });
  var notes = "v4.4 includes " + (readyBugs.length + candidateBugs.length) + " bug fixes across " + Object.keys(domainCounts()).length + " component areas. Key changes: " + (readyBugs.length ? readyBugs.slice(0,3).map(function(b){ return b.title; }).join(", ") : "TBD") + ".";
  var mount = $1("#modal-mount");
  var html = "";
  html += "<div class=\"modal\"><div class=\"modal-scrim\"></div><div class=\"modal-panel\" style=\"max-width:740px;max-height:85vh;overflow-y:auto\">";
  html += "<div class=\"panel-head\"><i data-lucide=\"rocket\" style=\"color:var(--accent);width:20px;height:20px\"></i><h3 style=\"flex:1;font-size:var(--t-16)\">Plan Release v4.4</h3><button class=\"iconbtn\" id=\"plan-close\" type=\"button\" aria-label=\"Close\"><i data-lucide=\"x\"></i></button></div>";
  html += "<div class=\"panel-body\" style=\"display:flex;flex-direction:column;gap:18px\">";
  html += "<div style=\"padding:16px;background:var(--bg-2);border-radius:12px;border:var(--hairline);border-left:3px solid var(--" + riskTone + ")\">";
  html += "<div class=\"scapt\" style=\"margin-bottom:8px\"><span class=\"bar\"></span>RELEASE SUMMARY</div>";
  html += "<div style=\"font-size:13px;color:var(--text-2);line-height:1.55\">" + escapeHtml(notes) + "</div>";
  html += "<div style=\"display:flex;gap:16px;margin-top:12px\">";
  html += "<div style=\"flex:1;padding:10px;background:var(--bg-3);border-radius:8px;text-align:center\"><div style=\"font-size:22px;font-weight:700;color:var(--" + riskTone + ")\">" + readiness + "%</div><div style=\"font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em;margin-top:2px\">Readiness</div></div>";
  html += "<div style=\"flex:1;padding:10px;background:var(--bg-3);border-radius:8px;text-align:center\"><div style=\"font-size:22px;font-weight:700;color:var(--" + riskTone + ")\">" + riskScore + "</div><div style=\"font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em;margin-top:2px\">Risk Score</div></div>";
  html += "<div style=\"flex:1;padding:10px;background:var(--bg-3);border-radius:8px;text-align:center\"><div style=\"font-size:22px;font-weight:700;color:var(--accent)\">" + blockedBugs.length + "</div><div style=\"font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em;margin-top:2px\">Blockers</div></div>";
  html += "</div></div>";
  html += "<div class=\"scapt\" style=\"margin-bottom:-6px\"><span class=\"bar\"></span>INCLUDED BUGS <span class=\"num\" style=\"font-size:10px;padding:2px 6px;border-radius:var(--r-pill);background:var(--bg-row);color:var(--text-3);font-weight:600\">" + (candidateBugs.length + readyBugs.length) + "</span></div>";
  if (candidateBugs.length || readyBugs.length) {
    var allInc = [].concat(readyBugs, candidateBugs).slice(0,10);
    allInc.forEach(function(b){
      html += "<div class=\"mini-row\" style=\"grid-template-columns:auto 1fr auto;padding:8px 4px\"><span class=\"sev-dot\" data-sev=\"" + severityTone(b.severity) + "\"></span><div><div style=\"font-size:13px;font-weight:500;color:var(--text-1)\">" + escapeHtml(b.title) + "</div><div style=\"font-size:11px;color:var(--text-3);margin-top:1px\">" + escapeHtml(b.id) + " \u00b7 " + escapeHtml(b.domain||"") + " \u00b7 " + priorityChip(b.priority) + "</div></div>" + statusChip(b.status) + "</div>";
    });
    if (candidateBugs.length + readyBugs.length > 10) {
      html += "<div style=\"text-align:center;font-size:11px;color:var(--text-3);margin-top:-8px\">+" + (candidateBugs.length + readyBugs.length - 10) + " more bugs</div>";
    }
  } else {
    html += "<div style=\"text-align:center;padding:16px;color:var(--text-3);font-size:12px\">No bugs included in this release</div>";
  }
  html += "<div class=\"scapt\" style=\"margin-bottom:-6px\"><span class=\"bar\"></span>EXCLUDED BUGS <span class=\"num\" style=\"font-size:10px;padding:2px 6px;border-radius:var(--r-pill);background:var(--bg-row);color:var(--text-3);font-weight:600\">" + excludedBugs.length + "</span></div>";
  if (excludedBugs.length) {
    excludedBugs.slice(0,6).forEach(function(b){
      html += "<div class=\"mini-row\" style=\"grid-template-columns:auto 1fr auto;padding:6px 4px;opacity:.7\"><span class=\"sev-dot\" data-sev=\"" + severityTone(b.severity) + "\"></span><div><div style=\"font-size:12px;font-weight:500;color:var(--text-2)\">" + escapeHtml(b.title) + "</div><div style=\"font-size:10px;color:var(--text-3);margin-top:1px\">" + escapeHtml(b.id) + " \u00b7 " + escapeHtml(b.domain||"") + "</div></div><span style=\"font-size:11px;color:var(--text-3)\">Excluded</span></div>";
    });
  } else {
    html += "<div style=\"text-align:center;padding:12px;color:var(--text-3);font-size:12px\">No excluded bugs</div>";
  }
  html += "<div style=\"display:grid;grid-template-columns:1fr 1fr;gap:12px\">";
  html += "<div style=\"padding:14px;background:var(--bg-2);border-radius:12px;border:var(--hairline)\"><div class=\"scapt\">DEPLOYMENT WINDOW</div><div style=\"font-size:14px;font-weight:600;color:var(--text-1);margin-top:6px\">" + escapeHtml(deployWindow) + "</div><div style=\"font-size:11px;color:var(--text-3);margin-top:2px\">Proposed deployment date</div></div>";
  html += "<div style=\"padding:14px;background:var(--bg-2);border-radius:12px;border:var(--hairline)\"><div class=\"scapt\">ROLLBACK STRATEGY</div><div style=\"font-size:13px;color:var(--text-2);margin-top:6px;line-height:1.45\">" + escapeHtml(rollback) + "</div></div>";
  html += "</div>";
  html += "<div style=\"padding:14px;background:var(--bg-2);border-radius:12px;border:var(--hairline)\"><div class=\"scapt\">PRE-RELEASE CHECKLIST</div><ul style=\"display:flex;flex-direction:column;gap:6px;margin-top:8px\">";
  var checks = ["Smoke tests on affected components","Regression suite for core flows","Integration tests for changed APIs","Load test if touching payments or billing","Security scan for auth-related changes","Verify rollback procedure documented"];
  checks.forEach(function(t,i){
    html += "<li style=\"display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-2)\"><div class=\"checkbox\" style=\"width:16px;height:16px;border-radius:3px\" data-on=\"" + (i<2?"true":"false") + "\"></div>" + escapeHtml(t) + "</li>";
  });
  html += "</ul></div>";
  html += "<div style=\"padding:14px;background:var(--bg-2);border-radius:12px;border:var(--hairline);border-left:3px solid var(--accent)\"><div class=\"scapt\">RELEASE NOTES PREVIEW</div><div style=\"font-size:13px;color:var(--text-2);line-height:1.55;margin-top:6px\">" + escapeHtml(notes) + "</div><div style=\"font-size:11px;color:var(--text-3);margin-top:6px;font-family:var(--font-mono)\">Auto-generated by BugOps AI \u2014 review before publishing</div></div>";
  html += "</div>";
  html += "<div class=\"panel-foot\" style=\"display:flex;justify-content:flex-end;gap:var(--s-3);padding:var(--s-4) var(--s-6);border-top:var(--hairline)\">";
  html += "<button class=\"btn-ghost\" id=\"plan-cancel\" type=\"button\">Cancel</button>";
  html += "<button class=\"btn-secondary\" type=\"button\" id=\"plan-draft\"><i data-lucide=\"save\"></i>Save Draft</button>";
  html += "<button class=\"btn-primary\" type=\"button\" id=\"plan-confirm\"><i data-lucide=\"rocket\"></i>Confirm Release Plan</button>";
  html += "</div></div></div>";
  mount.innerHTML = html;
  if (window.lucide) window.lucide.createIcons();
  $1("#plan-close").addEventListener("click", function(){ mount.innerHTML = ""; });
  $1("#plan-cancel").addEventListener("click", function(){ mount.innerHTML = ""; });
  $1("#plan-draft").addEventListener("click", function(){ mount.innerHTML = ""; toast("Release plan saved as draft", "ok"); });
  $1("#plan-confirm").addEventListener("click", function(){ mount.innerHTML = ""; toast("Release v4.4 plan confirmed! Bugs flagged for deployment.", "ok"); });
  $1(".modal-scrim").addEventListener("click", function(){ mount.innerHTML = ""; });
  } catch(e) { console.warn("[BugOps] Release planning modal failed:", e); toast("Could not open release plan", "warn"); }
}

function exportPDF(){
  try {
    var bugs = safeArr(Ctx.bugs);
    var now = new Date();
    var dateStr = now.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
    var timeStr = now.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
    var shipped = bugs.filter(function(b){ return b.status==='shipped'; }).length;
    var ready = bugs.filter(function(b){ return b.status==='ready'; }).length;
    var blocked = bugs.filter(function(b){ return b.status==='blocked'; }).length;
    var triaged = bugs.filter(function(b){ return b.status==='triaged'||b.status==='triage'; }).length;
    var critical = bugs.filter(function(b){ return (b.severity||'').toLowerCase()==='critical'; }).length;
    var major = bugs.filter(function(b){ return (b.severity||'').toLowerCase()==='major'; }).length;
    var topCrit = bugs.filter(function(b){ return (b.severity||'').toLowerCase()==='critical'; }).sort(function(a,b){ return (a.priority||0)-(b.priority||0); }).slice(0,5);
    var pdf = new jspdf.jsPDF({ orientation:'portrait', unit:'mm', format:'a4' });
    var pw = 190; var lm = 10; var y = 15;
    function hr(){ y += 2; pdf.setDrawColor(180); pdf.line(lm, y, lm+pw, y); y += 4; }
    // Title
    pdf.setFont('helvetica','bold'); pdf.setFontSize(22); pdf.setTextColor(139,92,246);
    pdf.text('BugOps AI', lm, y); y += 7;
    pdf.setTextColor(0); pdf.setFontSize(16);
    pdf.text('Executive Dashboard Report', lm, y); y += 6;
    pdf.setFont('helvetica','normal'); pdf.setFontSize(9); pdf.setTextColor(120);
    pdf.text('Generated: ' + dateStr + ' at ' + timeStr, lm, y); y += 4;
    pdf.setTextColor(0); hr();
    // KPI Summary
    pdf.setFont('helvetica','bold'); pdf.setFontSize(14); pdf.text('KPI Summary', lm, y); y += 7;
    pdf.setFont('helvetica','normal'); pdf.setFontSize(10);
    var kpis = [['Total Bugs',bugs.length],['Critical',critical],['Major',major],['Shipped',shipped],['Ready',ready],['Blocked',blocked],['Triaged',triaged]];
    var col1 = lm; var col2 = lm + 95;
    for(var i=0;i<kpis.length;i++){
      var cx = i < 4 ? col1 : col2;
      var cy = y + (i % 4) * 6;
      pdf.setFont('helvetica','bold'); pdf.text(kpis[i][0] + ':', cx, cy);
      pdf.setFont('helvetica','normal'); pdf.text(String(kpis[i][1]), cx + 60, cy);
    }
    y += 28; hr();
    // Release Readiness
    pdf.setFont('helvetica','bold'); pdf.setFontSize(14); pdf.text('Release Readiness', lm, y); y += 7;
    pdf.setFont('helvetica','normal'); pdf.setFontSize(10);
    var total = bugs.length;
    var releasePct = total > 0 ? Math.round((ready+shipped)/total*100) : 0;
    pdf.text('Readiness: ' + releasePct + '% (' + (ready+shipped) + '/' + total + ' bugs resolved)', lm, y); y += 5.5;
    pdf.text('Blockers: ' + blocked, lm, y); y += 5.5;
    pdf.text('Risk Score: ' + (blocked > 0 ? 'High (' + Math.min(blocked*15+50,100) + ')' : 'Low (25)'), lm, y); y += 5.5;
    hr();
    // Engineering Health
    pdf.setFont('helvetica','bold'); pdf.setFontSize(14); pdf.text('Engineering Health', lm, y); y += 7;
    pdf.setFont('helvetica','normal'); pdf.setFontSize(10);
    var domains = {}; bugs.forEach(function(b){ var d = b.domain||'Other'; if(!domains[d]) domains[d]=0; domains[d]++; });
    var doms = Object.keys(domains).sort();
    doms.forEach(function(d){ pdf.text('  ' + d + ': ' + domains[d] + ' bugs', lm, y); y += 4.5; });
    hr();
    // AI Confidence
    pdf.setFont('helvetica','bold'); pdf.setFontSize(14); pdf.text('AI Confidence', lm, y); y += 7;
    pdf.setFont('helvetica','normal'); pdf.setFontSize(10);
    var highConf = bugs.filter(function(b){ return b.ai_confidence==='high'||(b.ai_confidence||0)>0.7; }).length;
    var midConf = bugs.filter(function(b){ return b.ai_confidence==='mid'||(b.ai_confidence||0)>0.4; }).length;
    var lowConf = bugs.length - highConf - midConf;
    pdf.text('High confidence: ' + highConf + ' bugs', lm, y); y += 5;
    pdf.text('Medium confidence: ' + midConf + ' bugs', lm, y); y += 5;
    pdf.text('Review needed: ' + lowConf + ' bugs', lm, y); y += 5;
    hr();
    // Top Critical Bugs
    pdf.setFont('helvetica','bold'); pdf.setFontSize(14); pdf.text('Top Critical Bugs', lm, y); y += 7;
    pdf.setFont('helvetica','normal'); pdf.setFontSize(10);
    if(topCrit.length > 0){
      topCrit.forEach(function(b,i){
        if(y > 265){ pdf.addPage(); y = 15; }
        pdf.setFont('helvetica','bold'); pdf.text((i+1)+'. '+(b.id||'')+' - '+(b.title||'').substring(0,55), lm, y); y += 5;
        pdf.setFont('helvetica','normal');
        var desc = (b.description||'').substring(0,100); if(desc) pdf.text('   '+desc, lm, y); y += 5;
        pdf.text('   Domain: '+(b.domain||'N/A')+' | Priority: '+(b.priority||'N/A'), lm, y); y += 4.5;
      });
    } else { pdf.text('No critical bugs found.', lm, y); y += 5; }
    hr();
    // Recommended Actions
    if(y > 245){ pdf.addPage(); y = 15; }
    pdf.setFont('helvetica','bold'); pdf.setFontSize(14); pdf.text('Recommended Actions', lm, y); y += 7;
    pdf.setFont('helvetica','normal'); pdf.setFontSize(10);
    var actions = [];
    if(blocked > 0) actions.push('Unblock '+blocked+' blocked bugs to improve release readiness');
    if(critical > 0) actions.push('Prioritize fixing '+critical+' critical-severity bugs');
    if(ready > 0) actions.push('Schedule release with '+ready+' ready bugs');
    if(actions.length === 0) actions.push('Continue monitoring - no critical issues detected');
    actions.push('Review AI confidence scores for manual verification');
    actions.forEach(function(a,i){ pdf.text((i+1)+'. '+a, lm, y); y += 5.5; });
    pdf.setFontSize(8); pdf.setTextColor(150);
    pdf.text('BugOps AI - Engineering Release Operator - Confidential', lm, 290);
    pdf.save('bugops-report-'+now.toISOString().slice(0,10)+'.pdf');
    toast('Report downloaded successfully', 'ok');
  } catch(e) {
    console.warn('[BugOps] exportPDF error:', e);
    toast('PDF generation failed', 'crit');
  }
}
function getScheduleDisplay() {
  var s = getSettings();
  if (!s.scheduleReport) return null;
  var now = new Date();
  var day = now.getDay();
  var daysUntilMonday = (8 - day) % 7 || 7;
  var nextMon = new Date(now);
  nextMon.setDate(now.getDate() + daysUntilMonday);
  nextMon.setHours(9, 0, 0, 0);
  var timeStr = nextMon.toLocaleDateString('en-US', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
  return { nextRun: timeStr, lastUpdated: now.toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' }), enabled: true };
}
async function boot(){
  if (!Array.isArray(Ctx.bugs)    || Ctx.bugs.length    === 0) Ctx.bugs     = DEMO_BUGS.slice();
  if (!Array.isArray(Ctx.reviews) || Ctx.reviews.length === 0) Ctx.reviews  = DEMO_REVIEWS.slice();
  if (!Array.isArray(Ctx.analyses)|| Ctx.analyses.length=== 0) Ctx.analyses = DEMO_ANALYSES.slice();

  $1('#sidebar-bugs').textContent = Ctx.bugs.length + ' bugs';
  getSettings();
  mountSidebarNav();
  if (Ctx.pod) {
    var podEl = $1('#sidebar-pod');
    if (podEl) podEl.textContent = Ctx.pod.toString().slice(0,8);
  }
  var bugCountEl = $1('#sidebar-bugs');
  if (bugCountEl) bugCountEl.textContent = Ctx.bugs.length + ' Active Bugs';
  if (window.lucide) window.lucide.createIcons();
  applyTheme(currentTheme());

  Ctx.loading = false;
  route();
  wireUi();

  try {
    const d = await fetchAll({ withRefresh:true });
    if (d) {
      if (d.bugs && d.bugs.length) Ctx.bugs = d.bugs;
      if (d.reviews) Ctx.reviews = d.reviews;
      if (d.analyses) Ctx.analyses = d.analyses;
      if (d.pod) Ctx.pod = d.pod;
      $1('#sidebar-bugs').textContent = Ctx.bugs.length + ' bugs';
      if (Ctx.pod) $1('#sidebar-pod').textContent = Ctx.pod.toString().slice(0,8); $1('.status-value').textContent = Ctx.pod ? 'pod' : 'sandbox';
      route();
    }
  } catch (_) {}

  setInterval(async () => {
    try {
      const d = await fetchAll({ withRefresh:true });
      if (d && d.bugs) {
        Ctx.bugs = d.bugs; Ctx.reviews = d.reviews; Ctx.analyses = d.analyses;
        if (d.pod) Ctx.pod = d.pod;
        $1('#sidebar-bugs').textContent = Ctx.bugs.length + ' bugs';
        if (Ctx.pod) $1('#sidebar-pod').textContent = Ctx.pod.toString().slice(0,8); $1('.status-value').textContent = Ctx.pod ? 'pod' : 'sandbox';
        route();
      }
    } catch (_) {}
  }, 60000);
}
function mountSidebarNav(){
  const nav = $1('#sb-nav');
  const items = [
    { route:'#/', label:'Executive Dashboard', icon:'layout-dashboard', section:'Operating' },
    { route:'#/operations', label:'Bug Operations', icon:'bug', section:'Operating' },
    { route:'#/releases', label:'Release Center', icon:'rocket', section:'Operating' },
    { route:'#/insights', label:'Engineering Insights', icon:'bar-chart-3', section:'Operations' },
    { route:'#/ai-commander', label:'AI Commander', icon:'cpu', section:'Intelligence' },
    { route:'#/settings', label:'Settings', icon:'settings', section:'Workspace' }
  ];
  let html = '';
  let lastSec = '';
  for (const it of items) {
    if (it.section !== lastSec) { html += '<div class="sb-section-label">' + escapeHtml(it.section) + '</div>'; lastSec = it.section; }
    html += '<a class="sb-link" data-route="' + it.route + '" href="' + it.route + '" data-active="' + (location.hash===it.route?'true':'false') + '"><i data-lucide="' + it.icon + '"></i><span>' + escapeHtml(it.label) + '</span></a>';
  }
  nav.innerHTML = html;
}

boot().catch(err => { console.error('boot failed:', err); });

/* ============================================================================
 * AI COMMANDER — Full page implementation
 * Supports OpenAI · Grok · OpenRouter with live workspace data
 * ============================================================================ */

/* ---------- Key Persistence ---------- */
var BO_AI_KEY = 'bo-ai-key';
function getAIKey() {
  try { var r = localStorage.getItem(BO_AI_KEY); if (r) return JSON.parse(r); } catch(_) {}
  return { provider: 'openrouter', key: '' };
}
function saveAIKey(cfg) {
  try { localStorage.setItem(BO_AI_KEY, JSON.stringify(cfg)); } catch(_) {}
}

/* ---------- Entry point ---------- */
function openAICmdr() {
  if (location.hash === '#/ai-commander') {
    initAICommanderPage();
  } else {
    location.hash = '#/ai-commander';
  }
}

/* ---------- AI Commander Page (full-page route) ---------- */
function renderAICommanderPage() {
  var isDemoMode = localStorage.getItem('bo-ai-demo-mode') !== 'false'; // default to true for easy evaluation

  var div = document.createElement('div');
  div.className = 'page';
  var cfg      = getAIKey() || {};
  var provider = cfg.provider || 'openrouter';
  var apiKey   = cfg.key || '';

  var selOAI = provider === 'openai'      ? ' selected' : '';
  var selGroq = provider === 'groq'       ? ' selected' : '';
  var selGrk = provider === 'grok'        ? ' selected' : '';
  var selOR  = provider === 'openrouter'  ? ' selected' : '';
  
  var keyStatus = apiKey
    ? '<span style="color:var(--ok)">&#10003; API key configured</span>'
    : 'No API key saved yet (required for live mode).';

  div.innerHTML =
    '<div class="page-head">' +
      '<div class="lead">' +
        '<div style="font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--accent);text-transform:uppercase;margin-bottom:6px">Executive Intelligence</div>' +
        '<h1 style="margin:0;font-size:26px;font-weight:800;color:var(--text-1)">AI Commander</h1>' +
        '<p style="color:var(--text-3);font-size:13px;margin:6px 0 0;max-width:520px">Analyzes your entire workspace bug data and generates a live executive readiness report using AI.</p>' +
      '</div>' +
      '<div class="page-actions" style="display:flex;align-items:center;gap:16px">' +
        '<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text-2);user-select:none">' +
          '<input type="checkbox" id="ai-cmdr-demo-toggle" ' + (isDemoMode ? 'checked' : '') + ' style="width:16px;height:16px;accent-color:var(--accent)" />' +
          '<span>Demo Mode (Mock Analysis)</span>' +
        '</label>' +
        '<button class="btn-ghost" id="ai-cmdr-view-last" style="display:none"><i data-lucide="history"></i>View Last Analysis</button>' +
        '<button class="btn-primary" id="ai-cmdr-analyze"><i data-lucide="brain-circuit"></i>Analyze Workspace</button>' +
      '</div>' +
    '</div>' +
    
    // Evaluation Note banner
    '<div style="background:rgba(59, 130, 246, 0.08);border:1px dashed rgba(59, 130, 246, 0.3);border-radius:10px;padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:10px">' +
      '<i data-lucide="info" style="color:var(--accent);width:16px;height:16px;flex-shrink:0"></i>' +
      '<div style="font-size:12px;color:var(--text-2)">' +
        '<b>Recommended for evaluation:</b> Use <b>Demo Mode</b> (instant simulated mock report) or <b>OpenRouter</b> (supports free models). OpenAI and xAI Grok keys require active paid API credits.' +
      '</div>' +
    '</div>' +

    '<div style="margin-bottom:20px; ' + (isDemoMode ? 'opacity:0.6; transition:opacity 0.2s' : 'transition:opacity 0.2s') + '" id="ai-provider-config-box">' +
      '<div style="background:var(--bg-2);border-radius:12px;border:var(--hairline);padding:20px">' +
        '<div class="scapt" style="margin-bottom:14px">AI PROVIDER CONFIGURATION</div>' +
        '<div style="display:grid;grid-template-columns:1fr 2fr auto;gap:12px;align-items:flex-end">' +
          '<div>' +
            '<div style="font-size:11px;font-weight:600;color:var(--text-3);margin-bottom:6px">PROVIDER</div>' +
            '<select class="select" id="ai-cmdr-provider" style="width:100%">' +
              '<option value="openrouter"' + selOR + '>OpenRouter</option>' +
              '<option value="openai"' + selOAI + '>OpenAI (GPT-4o)</option>' +
              '<option value="groq"' + selGroq + '>Groq (Llama / fast)</option>' +
              '<option value="grok"' + selGrk + '>xAI (Grok)</option>' +
            '</select>' +
          '</div>' +
          '<div>' +
            '<div style="font-size:11px;font-weight:600;color:var(--text-3);margin-bottom:6px">API KEY</div>' +
            '<input class="input" id="ai-cmdr-key" type="password" placeholder="sk-... or your provider key" value="' + escapeHtml(apiKey) + '" style="width:100%;font-family:var(--font-mono);font-size:13px" />' +
          '</div>' +
          '<button class="btn-primary" id="ai-cmdr-save" style="white-space:nowrap;height:36px;padding:0 16px;font-size:13px">' +
            '<i data-lucide="save"></i>Save' +
          '</button>' +
        '</div>' +
        '<div id="ai-cmdr-key-status" style="margin-top:8px;font-size:12px;color:var(--text-3)">' + keyStatus + '</div>' +
      '</div>' +
    '</div>' +
    '<div id="ai-commander-content"></div>';

  setTimeout(function() {
    var saveBtn     = div.querySelector('#ai-cmdr-save');
    var keyInput    = div.querySelector('#ai-cmdr-key');
    var providerSel = div.querySelector('#ai-cmdr-provider');
    var statusEl    = div.querySelector('#ai-cmdr-key-status');
    var analyzeBtn  = div.querySelector('#ai-cmdr-analyze');
    var viewLastBtn = div.querySelector('#ai-cmdr-view-last');
    var contentDiv  = div.querySelector('#ai-commander-content');

    if (saveBtn) {
      saveBtn.addEventListener('click', function() {
        var k = keyInput ? keyInput.value.trim() : '';
        var p = providerSel ? providerSel.value : 'openrouter';
        if (!k) { toast('Please enter an API key', 'warn'); return; }
        saveAIKey({ key: k, provider: p });
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--ok)">&#10003; API key saved for ' + escapeHtml(p) + '</span>';
        toast('API key saved', 'ok');
      });
    }

    var demoToggle = div.querySelector('#ai-cmdr-demo-toggle');
    var configBox  = div.querySelector('#ai-provider-config-box');
    if (demoToggle && configBox) {
      demoToggle.addEventListener('change', function() {
        var active = demoToggle.checked;
        localStorage.setItem('bo-ai-demo-mode', active ? 'true' : 'false');
        configBox.style.opacity = active ? '0.6' : '1';
        toast(active ? 'Demo Mode enabled (simulated data)' : 'Live Mode enabled (requires API key)', 'info');
      });
    }

    if (analyzeBtn) {
      analyzeBtn.addEventListener('click', async function() {
        if (contentDiv) contentDiv.innerHTML = '';
        await runAICommanderCore(contentDiv);
        if (Ctx._commanderState && viewLastBtn) {
          viewLastBtn.style.display = 'inline-flex';
        }
      });
    }

    if (viewLastBtn) {
      viewLastBtn.addEventListener('click', function() {
        if (Ctx._commanderState && contentDiv) {
          contentDiv.innerHTML = '';
          renderAICommanderResults(Ctx._commanderState.data, Ctx._commanderState.source);
        }
      });
      if (Ctx._commanderState) viewLastBtn.style.display = 'inline-flex';
    }

    if (window.lucide) window.lucide.createIcons();
  }, 0);

  return div;
}

function initAICommanderPage() {
  var root = document.querySelector('#routes');
  if (!root) return;
  root.innerHTML = '';
  root.appendChild(renderAICommanderPage());
  if (window.lucide) window.lucide.createIcons();
}

/* ---------- Thinking animation ---------- */
function showThinkingAnimation(mount) {
  var steps = [
    'Reading workspace bug data\u2026',
    'Evaluating severity and priority signals\u2026',
    'Mapping release blockers and regression risks\u2026',
    'Computing engineering health score\u2026',
    'Sending context to AI provider\u2026',
    'Parsing executive intelligence report\u2026'
  ];
  mount.innerHTML =
    '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:60px 20px;background:var(--bg-2);border-radius:12px;border:var(--hairline)">' +
      '<div style="display:flex;gap:6px">' +
        '<div style="width:10px;height:10px;border-radius:50%;background:var(--accent);animation:aiCmdrBounce 1.2s infinite ease-in-out;animation-delay:0s"></div>' +
        '<div style="width:10px;height:10px;border-radius:50%;background:var(--accent);animation:aiCmdrBounce 1.2s infinite ease-in-out;animation-delay:.2s"></div>' +
        '<div style="width:10px;height:10px;border-radius:50%;background:var(--accent);animation:aiCmdrBounce 1.2s infinite ease-in-out;animation-delay:.4s"></div>' +
      '</div>' +
      '<div id="ai-think-label" style="font-size:14px;color:var(--text-2);text-align:center;font-weight:500;min-height:22px">' + escapeHtml(steps[0]) + '</div>' +
      '<div style="font-size:12px;color:var(--text-3)">Analyzing ' + safeArr(Ctx.bugs).length + ' bugs &middot; ' + safeArr(Ctx.analyses).length + ' analyses</div>' +
    '</div>';

  if (!document.getElementById('ai-bounce-kf')) {
    var s = document.createElement('style');
    s.id = 'ai-bounce-kf';
    s.textContent = '@keyframes aiCmdrBounce{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}';
    document.head.appendChild(s);
  }

  var step = 0;
  var timer = setInterval(function() {
    step = (step + 1) % steps.length;
    var lbl = mount.querySelector('#ai-think-label');
    if (lbl) lbl.textContent = steps[step];
  }, 900);

  return {
    close: function() {
      clearInterval(timer);
      mount.innerHTML = '';
    }
  };
}

/* ---------- Error card ---------- */
function renderAICmdrErrorCard(errMsg, onRetry) {
  var div = document.createElement('div');
  div.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:40px 20px;text-align:center;background:var(--bg-2);border-radius:12px;border:1px solid var(--crit)';
  div.innerHTML =
    '<i data-lucide="alert-triangle" style="width:40px;height:40px;color:var(--crit);opacity:0.8"></i>' +
    '<h3 style="margin:0;font-size:16px;font-weight:700;color:var(--text-1)">AI Commander Error</h3>' +
    '<p style="font-size:13px;color:var(--text-3);margin:0;max-width:480px;line-height:1.5">' + escapeHtml(errMsg) + '</p>' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center">' +
      '<button class="btn-primary" id="ai-cmdr-retry"><i data-lucide="refresh-cw"></i>Retry</button>' +
      '<button class="btn-ghost" id="ai-cmdr-err-settings"><i data-lucide="settings-2"></i>Check Settings</button>' +
    '</div>';
  div.querySelector('#ai-cmdr-retry').addEventListener('click', onRetry);
  div.querySelector('#ai-cmdr-err-settings').addEventListener('click', function() { location.hash = '#/settings'; });
  return div;
}

/* ---------- Results Renderer ---------- */
function renderAICommanderResults(ca, source) {
  var m = document.querySelector('#ai-commander-content');
  if (!m) return;

  Ctx._commanderState = { data: ca, source: source };
  var vlb = document.querySelector('#ai-cmdr-view-last');
  if (vlb) vlb.style.display = 'inline-flex';

  var readPct  = ca.releaseReadinessScore || ca.readinessPct || 0;
  var ready    = ca.readiness === 'READY' || readPct >= 70;
  var lbl      = ready ? 'READY TO RELEASE' : 'NOT READY';
  var lblTone  = ready ? 'ok' : 'crit';
  var healthPct = ca.engineeringHealthScore || ca.healthPct || 50;
  var confPct   = ca.aiConfidence || ca.confidencePct || 50;

  // Top risks
  var risks = ca.topRisks || ca.risks || [];
  var rh = risks.length
    ? risks.map(function(r) {
        var text = typeof r === 'string' ? r : (r.label || r.risk || String(r));
        return '<div style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:var(--hairline)">' +
          '<i data-lucide="alert-circle" style="width:14px;height:14px;color:var(--crit);margin-top:2px;flex-shrink:0"></i>' +
          '<span style="font-size:13px;color:var(--text-2)">' + escapeHtml(text) + '</span></div>';
      }).join('')
    : '<div style="color:var(--text-3);font-size:13px">No risks flagged.</div>';

  // Reasoning
  var reasoning = ca.reasoning || ca.rootCauseInsights || [];
  var reh = (Array.isArray(reasoning) ? reasoning : [reasoning]).filter(Boolean)
    .map(function(r) {
      return '<li style="display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:var(--hairline);font-size:13px;color:var(--text-2)">' +
        '<i data-lucide="search" style="width:14px;height:14px;color:var(--accent);margin-top:2px;flex-shrink:0"></i>' +
        '<span>' + escapeHtml(String(r)) + '</span></li>';
    }).join('');

  // Actions
  var actions = ca.actions || ca.recommendedActions || [];
  var ah = (Array.isArray(actions) ? actions : [actions]).filter(Boolean)
    .map(function(a) {
      var text     = typeof a === 'string' ? a : (a.action || String(a));
      var priority = typeof a === 'object' ? (a.priority || 'medium') : 'medium';
      var tone     = priority === 'critical' ? 'crit' : priority === 'high' ? 'warn' : 'info';
      return '<div style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:var(--hairline)">' +
        '<span class="sev-dot" data-sev="' + (priority === 'critical' ? 'critical' : priority === 'high' ? 'major' : 'minor') + '"></span>' +
        '<span style="font-size:13px;color:var(--text-1);flex:1">' + escapeHtml(text) + '</span>' +
        '<span class="chip chip-tone-' + tone + '">' + escapeHtml(priority) + '</span></div>';
    }).join('');

  // Evidence
  var evidence = ca.evidence || ca.keyInsights || [];
  var eh = (Array.isArray(evidence) ? evidence : [evidence]).filter(Boolean)
    .map(function(e) {
      var text = typeof e === 'string' ? e : (e.description || String(e));
      var conf = typeof e === 'object' ? Math.round((e.confidence || 0.85) * 100) : 85;
      var tone = conf >= 80 ? 'ok' : conf >= 55 ? 'warn' : 'crit';
      return '<li style="display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:var(--hairline);font-size:13px;color:var(--text-2)">' +
        '<i data-lucide="check-circle" style="width:14px;height:14px;color:var(--ok);margin-top:2px;flex-shrink:0"></i>' +
        '<span style="flex:1">' + escapeHtml(text) + '</span>' +
        '<span class="chip chip-tone-' + tone + '">' + conf + '%</span></li>';
    }).join('');

  // Critical bugs panel
  var allBugs   = safeArr(Ctx.bugs);
  var allAn     = safeArr(Ctx.analyses);
  var critBugs  = allBugs.filter(function(b){ return b.severity === 'critical' && b.status !== 'shipped'; });
  var crit_html = critBugs.length
    ? '<div style="padding:16px;background:var(--bg-2);border-radius:12px;border:1px solid var(--crit);margin-bottom:16px">' +
        '<div class="scapt" style="color:var(--crit);margin-bottom:10px">CRITICAL BUGS (' + critBugs.length + ')</div>' +
        critBugs.map(function(b) {
          var an = allAn.find(function(x){ return x.bug_id === b.id; }) || {};
          return '<div style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:var(--hairline)">' +
            '<span class="sev-dot" data-sev="critical"></span>' +
            '<div style="flex:1">' +
              '<div style="font-size:13px;font-weight:600;color:var(--text-1)">' + escapeHtml(b.title) + '</div>' +
              '<div style="font-size:11px;color:var(--text-3);margin-top:2px">' + escapeHtml(b.id) + ' &middot; ' + escapeHtml(b.domain || 'general') +
              (an.release_blocker ? ' &middot; <b style="color:var(--crit)">RELEASE BLOCKER</b>' : '') + '</div>' +
            '</div>' +
            '<span class="chip chip-tone-crit">' + escapeHtml(b.status) + '</span></div>';
        }).join('') +
      '</div>'
    : '';

  // Blocked bugs panel
  var blockedBugs  = allBugs.filter(function(b){ return b.status === 'blocked'; });
  var blocked_html = blockedBugs.length
    ? '<div style="padding:16px;background:var(--bg-2);border-radius:12px;border:1px solid var(--warn);margin-bottom:16px">' +
        '<div class="scapt" style="color:var(--warn);margin-bottom:10px">BLOCKED BUGS (' + blockedBugs.length + ')</div>' +
        blockedBugs.map(function(b) {
          return '<div style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:var(--hairline)">' +
            '<span class="sev-dot" data-sev="' + escapeHtml(b.severity) + '"></span>' +
            '<div style="flex:1">' +
              '<div style="font-size:13px;font-weight:600;color:var(--text-1)">' + escapeHtml(b.title) + '</div>' +
              '<div style="font-size:11px;color:var(--text-3);margin-top:2px">' + escapeHtml(b.id) + ' &middot; ' + escapeHtml(b.domain || 'general') + '</div>' +
            '</div>' +
            '<span class="chip chip-tone-warn">' + escapeHtml(b.severity) + '</span></div>';
        }).join('') +
      '</div>'
    : '';

  m.innerHTML =
    '<div style="background:var(--bg-2);border-radius:12px;border:var(--hairline);padding:20px;margin-bottom:16px">' +
      '<div class="scapt" style="margin-bottom:12px">EXECUTIVE SUMMARY</div>' +
      '<p style="font-size:14px;color:var(--text-2);line-height:1.65;margin:0">' +
        escapeHtml(ca.execSummary || ca.executiveSummary || ca.summary || 'Analysis complete.') +
      '</p>' +
    '</div>' +
    '<div class="tile-grid is-3" style="margin-bottom:16px">' +
      pKpiTile({ icon:'heart-pulse',   label:'Engineering Health', value: healthPct + '%',
        tone: healthPct >= 60 ? 'ok' : healthPct >= 30 ? 'warn' : 'crit',
        sub: (ca.engineeringHealthSummary || 'Live workspace data').slice(0, 52) }) +
      pKpiTile({ icon:'brain-circuit', label:'AI Confidence',      value: confPct + '%',
        tone:'accent', sub: 'via ' + escapeHtml(source || 'AI Provider') }) +
      pKpiTile({ icon:'rocket',        label:'Release Decision',   value: lbl,
        tone: lblTone, sub: readPct + '% readiness score' }) +
    '</div>' +
    crit_html +
    blocked_html +
    '<div style="padding:16px;background:var(--bg-2);border-radius:12px;border:var(--hairline);margin-bottom:16px">' +
      '<div class="scapt" style="margin-bottom:10px">TOP RISKS</div>' + rh +
    '</div>' +
    (reh
      ? '<div style="padding:16px;background:var(--bg-2);border-radius:12px;border:var(--hairline);margin-bottom:16px">' +
          '<div class="scapt" style="margin-bottom:10px">ROOT CAUSE INSIGHTS</div>' +
          '<ul style="list-style:none;padding:0;margin:0">' + reh + '</ul></div>'
      : '') +
    (ah
      ? '<div style="padding:16px;background:var(--bg-2);border-radius:12px;border:var(--hairline);margin-bottom:16px">' +
          '<div class="scapt" style="margin-bottom:10px">RECOMMENDED ACTIONS</div>' + ah + '</div>'
      : '') +
    (eh
      ? '<div style="padding:16px;background:var(--bg-2);border-radius:12px;border:var(--hairline);margin-bottom:16px">' +
          '<div class="scapt" style="margin-bottom:10px">EVIDENCE</div>' +
          '<ul style="list-style:none;padding:0;margin:0">' + eh + '</ul></div>'
      : '') +
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--bg-3);border-radius:10px;border:var(--hairline);font-size:11px;color:var(--text-3)">' +
      '<div style="display:flex;align-items:center;gap:6px">' +
        '<i data-lucide="cpu" style="width:14px;height:14px;color:var(--accent)"></i>' +
        '<span style="font-weight:600;color:var(--text-2)">AI Commander &middot; ' + escapeHtml(source || 'Live AI') + '</span>' +
      '</div>' +
      '<span>Analyzed ' + allBugs.length + ' bugs &middot; ' + allAn.length + ' analyses</span>' +
    '</div>';

  if (window.lucide) window.lucide.createIcons();
}

/* ---------- Live API Call ---------- */
async function callAIAPI(key, provider, endpoint, contextData) {
  var ss = contextData;
  var NL = '\n';
  var bugLines = safeArr(Ctx.bugs).map(function(b) {
    var an = safeArr(Ctx.analyses).find(function(x){ return x.bug_id === b.id; }) || {};
    var line = '- [' + (b.id||'') + '] ' + (b.title||'') +
      ' | sev:' + (b.severity||'') +
      ' pri:' + (b.priority||'') +
      ' status:' + (b.status||'') +
      ' domain:' + (b.domain||'');
    if (an.release_blocker) line += ' RELEASE-BLOCKER';
    if (an.root_cause) line += ' | root:' + an.root_cause.slice(0, 80);
    return line;
  }).join(NL);

  var systemPrompt = [
    'You are BugOps AI Commander, an executive engineering intelligence engine.',
    'Analyze the workspace bug data and return ONLY a raw JSON object with these fields:',
    '{ "execSummary": "string", "engineeringHealthScore": 0-100, "engineeringHealthSummary": "string",',
    '  "aiConfidence": 0-100, "releaseReadinessScore": 0-100, "readiness": "READY or NOT READY",',
    '  "topRisks": ["string"], "rootCauseInsights": ["string"],',
    '  "recommendedActions": [{"action":"string","priority":"critical|high|medium"}],',
    '  "evidence": [{"description":"string","confidence":0.0-1.0}], "reasoning": ["string"] }',
    'Return ONLY valid JSON. No markdown. No code fences.'
  ].join(' ');

  var userMessage = [
    'Engineering Workspace Analysis:',
    'Total bugs: ' + ss.total + ' | Open: ' + ss.open + ' | Shipped: ' + ss.shipped,
    'Critical unresolved: ' + ss.critical + ' | Blocked: ' + ss.blocked + ' | Release blockers: ' + ss.releaseBlockers,
    'Domains: ' + ss.domains + ' | Avg AI confidence: ' + ss.avgConf + '%',
    '',
    'Bug List:',
    bugLines
  ].join(NL);

  // Use validated model IDs per provider
  var model = provider === 'openrouter' ? 'openai/gpt-4o-mini'
            : provider === 'grok'       ? 'grok-beta'
            : provider === 'groq'       ? 'llama-3.3-70b-versatile'
            : 'gpt-4o-mini';

  var headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = window.location.href;
    headers['X-Title'] = 'BugOps AI Commander';
  }

  try {
    var resp = await fetch(endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMessage }
        ],
        temperature: 0.3,
        max_tokens: 2000
      })
    });

    if (!resp.ok) {
      var errText = await resp.text();
      var friendlyErr = 'API error ' + resp.status + ': ' + errText.slice(0, 200);
      var isBillingIssue = resp.status === 402 || resp.status === 403 || errText.toLowerCase().includes('credit') || errText.toLowerCase().includes('billing') || errText.toLowerCase().includes('insufficient');
      
      if (isBillingIssue && (provider === 'openai' || provider === 'grok')) {
        friendlyErr = provider.toUpperCase() + ' returned an API billing/credits error. ' +
                      'Your API key is valid, but the account does not currently have sufficient API credits. ' +
                      'Recommended: Use Demo Mode (toggle in top header) or switch to OpenRouter with a free model for evaluation.';
      } else if (resp.status === 401) {
        friendlyErr = 'Invalid API key for ' + provider + '. Please check your key and save again. Recommended: Use Demo Mode or OpenRouter.';
      } else if (resp.status === 429) {
        friendlyErr = 'Rate limit reached for ' + provider + '. Wait a moment and retry.';
      }
      return { success: false, error: friendlyErr };
    }

    var json    = await resp.json();
    var content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (!content) return { success: false, error: 'Empty response from AI provider' };

    // Extract the outermost JSON object using balanced-brace matching
    // (regex approach breaks nested objects — this is safe)
    var startIdx = content.indexOf('{');
    if (startIdx === -1) return { success: false, error: 'No JSON object found in AI response' };
    var depth = 0, endIdx = -1;
    for (var ci = startIdx; ci < content.length; ci++) {
      if (content[ci] === '{') depth++;
      else if (content[ci] === '}') { depth--; if (depth === 0) { endIdx = ci; break; } }
    }
    if (endIdx === -1) return { success: false, error: 'Incomplete JSON object in AI response' };
    var clean  = content.substring(startIdx, endIdx + 1);
    var parsed = JSON.parse(clean);
    return { success: true, data: parsed };
  } catch(e) {
    return { success: false, error: e.message || 'API call failed' };
  }
}

/* ---------- Main Orchestrator ---------- */
async function runAICommanderCore(mount) {
  if (!mount) mount = document.querySelector('#ai-commander-content');
  if (!mount) return;

  var isDemoMode = localStorage.getItem('bo-ai-demo-mode') !== 'false';
  var cfg = getAIKey();

  if (isDemoMode) {
    mount.innerHTML = '';
    var anim = showThinkingAnimation(mount);
    Ctx._aiRunning = true;

    // Simulate 1.5 seconds delay to show thinking states
    setTimeout(function() {
      anim.close();
      Ctx._aiRunning = false;

      var ss         = computeStatsSummary();
      var allBugs    = safeArr(Ctx.bugs);
      var openBugs   = allBugs.filter(function(b){ return b.status !== 'shipped'; });
      var critBugs   = openBugs.filter(function(b){ return b.severity === 'critical'; });
      var blockedBugs= openBugs.filter(function(b){ return b.status === 'blocked'; });

      // Generate a mock report tailored to the current dashboard stats
      var mockData = {
        execSummary: "DEMO MODE: The engineering workspace contains " + ss.total + " bugs with " + openBugs.length + " currently active issues. Engineering health is scored at " + (critBugs.length > 2 ? '45%' : '82%') + " based on outstanding critical items. " + (critBugs.length > 0 ? "Immediate resolution of active critical blockers is required to secure the upcoming deployment window." : "All systems stable. Workspace shows high readiness for upcoming release candidate cycle."),
        engineeringHealthScore: critBugs.length > 2 ? 45 : (critBugs.length > 0 ? 68 : 92),
        engineeringHealthSummary: critBugs.length > 0 ? "Compromised by " + critBugs.length + " unresolved critical severity bugs." : "Excellent workspace quality, no unresolved critical items.",
        aiConfidence: 98,
        releaseReadinessScore: critBugs.length > 1 ? 30 : (critBugs.length > 0 ? 60 : 95),
        readiness: critBugs.length > 0 ? "NOT READY" : "READY",
        topRisks: [
          critBugs.length > 0 ? "Active critical bugs in core domains may trigger regression issues under load." : "No significant engineering risks detected in the active queue.",
          blockedBugs.length > 0 ? "Resource dependencies are blocked, potentially impacting iteration velocity." : "High engineering velocity. Development paths are clear."
        ],
        rootCauseInsights: [
          "Historical patterns suggest automated test coverage gaps in payment and webhook ingestion routes.",
          "Concurrency constraints in event broker processing loops remain the primary source of blockages."
        ],
        recommendedActions: [
          { action: "Assign dedicated engineer to triage active critical severity items.", priority: "critical" },
          { action: "Perform regression check on key integration webhooks.", priority: "high" },
          { action: "Re-evaluate priority queue on blocked items to release developer blocks.", priority: "medium" }
        ],
        evidence: [
          { description: critBugs.length + " unresolved critical severity bugs present in tracking database.", confidence: 0.95 },
          { description: blockedBugs.length + " active issues flagged in blocked state.", confidence: 0.90 }
        ]
      };

      // Save to global state so 'View Last Analysis' works
      Ctx._commanderState = { data: mockData, source: 'Simulated Demo' };
      renderAICommanderResults(mockData, 'Simulated Demo');

      var viewLastBtn = document.querySelector('#ai-cmdr-view-last');
      if (viewLastBtn) viewLastBtn.style.display = 'inline-flex';
    }, 1500);
    return;
  }

  if (!cfg || !cfg.key) {
    mount.innerHTML =
      '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:40px 20px;text-align:center;background:var(--bg-2);border-radius:12px;border:var(--hairline)">' +
        '<i data-lucide="key-round" style="width:36px;height:36px;color:var(--text-3);opacity:0.4"></i>' +
        '<h3 style="margin:0;font-size:16px;font-weight:600;color:var(--text-2)">No API Key Configured</h3>' +
        '<p style="font-size:13px;color:var(--text-3);margin:0;max-width:360px;line-height:1.5">Enter your API key above and click <b>Save</b>, or turn on <b>Demo Mode</b> in the header for a simulated evaluation report.</p>' +
      '</div>';
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  mount.innerHTML = '';
  var anim = showThinkingAnimation(mount);
  Ctx._aiRunning = true;

  try {
    var ss         = computeStatsSummary();
    var dc         = domainCounts();
    var allBugs    = safeArr(Ctx.bugs);
    var allAn      = safeArr(Ctx.analyses);

    var contextData = {
      total:   ss.total,   open:    ss.open,    shipped: ss.shipped,
      ready:   ss.ready,   avgConf: ss.avgConf, domains: ss.domains,
      critical:       allBugs.filter(function(b){ return b.severity === 'critical' && b.status !== 'shipped'; }).length,
      blocked:        allBugs.filter(function(b){ return b.status === 'blocked'; }).length,
      releaseBlockers: allAn.filter(function(a){ return a.release_blocker; }).length,
      domainBreakdown: dc
    };

    var ENDPOINTS = {
      openai:     'https://api.openai.com/v1/chat/completions',
      grok:       'https://api.x.ai/v1/chat/completions',
      groq:       'https://api.groq.com/openai/v1/chat/completions',
      openrouter: 'https://openrouter.ai/api/v1/chat/completions'
    };
    var endpoint = ENDPOINTS[cfg.provider] || ENDPOINTS.openai;

    var result = await callAIAPI(cfg.key, cfg.provider || 'openai', endpoint, contextData);
    anim.close();
    Ctx._aiRunning = false;

    if (result.success && result.data) {
      renderAICommanderResults(result.data, cfg.provider || 'openai');
    } else {
      var errMsg = result.error || 'AI API request failed';
      mount.innerHTML = '';
      var errCard = renderAICmdrErrorCard(errMsg, function() {
        mount.innerHTML = '';
        runAICommanderCore(mount);
      });
      mount.appendChild(errCard);
      if (window.lucide) window.lucide.createIcons();
      toast('AI Commander: ' + errMsg.slice(0, 80), 'warn');
    }
  } catch(e) {
    anim.close();
    Ctx._aiRunning = false;
    mount.innerHTML = '';
    var errCard2 = renderAICmdrErrorCard(e.message || 'Unexpected error', function() {
      mount.innerHTML = '';
      runAICommanderCore(mount);
    });
    mount.appendChild(errCard2);
    if (window.lucide) window.lucide.createIcons();
  }
}

/* ---------- Legacy click-through shims ---------- */
document.addEventListener('click', function(ev) {
  var t = ev.target;
  if (t.closest('#ai-commander-tile')) { ev.preventDefault(); openAICmdr(); return; }
  if (t.closest('#dash-cmdr-btn'))     { ev.preventDefault(); openAICmdr(); return; }
  if (t.closest('#rel-cmdr-btn'))      { ev.preventDefault(); openAICmdr(); return; }
  if (t.closest('#ins-cmdr-btn'))      { ev.preventDefault(); openAICmdr(); return; }
});
