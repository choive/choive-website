// generate-report.js
// CHOIVE™ — Generates a branded PDF report from a completed diagnostic
// Called by stripe-webhook.js when a $499 Report payment is confirmed
// Flow: fetch diagnostic from Supabase → build PDF HTML → email via Resend
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY

const { getDiagnostic } = require('./lib/supabase');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// ── SAFE ACCESSORS ────────────────────────────────────────────────────────────
function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pillarScore(r, key) {
  return (r && r.pillars && r.pillars[key] && typeof r.pillars[key].score === 'number')
    ? r.pillars[key].score : 0;
}
function pillarFinding(r, key) {
  return (r && r.pillars && r.pillars[key]) ? (r.pillars[key].finding || '') : '';
}
function pillarAnalysis(r, key) {
  return (r && r.pillars && r.pillars[key]) ? (r.pillars[key].analysis || pillarFinding(r, key)) : '';
}
function pillarEvidence(r, key) {
  return (r && r.pillars && r.pillars[key]) ? (r.pillars[key].evidence || '') : '';
}
function pct(score, max) { return Math.round((score / max) * 100); }

// ── STATUS COLOURS ────────────────────────────────────────────────────────────
function statusColour(status) {
  if (status === 'present') return '#2A7A48';
  if (status === 'weak')    return '#9A6A14';
  return '#B83232';
}
function statusLabel(status) {
  if (status === 'present') return 'Cited';
  if (status === 'weak')    return 'Weak signal';
  return 'Not found';
}

// ── BUILD PDF HTML ────────────────────────────────────────────────────────────
function buildReportHTML(diagnostic) {
  var input  = diagnostic.input  || {};
  var r      = diagnostic.result || {};
  var date   = new Date().toLocaleDateString('en-GB', { year:'numeric', month:'long', day:'numeric' });

  var bizName  = esc(input.name     || 'Your Business');
  var category = esc(input.category || '');
  var city     = esc(input.city     || '');
  var website  = esc(input.website  || '');

  var score       = Number(r.overallScore) || 0;
  var verdict     = esc(r.verdictHeadline || '');
  var summary     = esc(r.summaryParagraph || '');
  var evidence    = esc(r.evidenceNarrative || '');

  // Pillars
  var cl = pillarScore(r,'clarity');    var tr = pillarScore(r,'trust');
  var di = pillarScore(r,'difference'); var ea = pillarScore(r,'ease');

  // Platform coverage
  var pc = r.platformCoverage || {};
  var platforms = ['chatgpt','perplexity','gemini','claude'];
  var platformNames = { chatgpt:'ChatGPT', perplexity:'Perplexity', gemini:'Gemini', claude:'Claude' };

  // Competitor
  var comp = r.displacement || (r.competitors && r.competitors[0]) || {};
  var compName = esc(comp.competitorName || comp.name || '');
  var compWhy  = esc(comp.competitorWhy  || comp.analysis || '');
  var compQuery = esc(comp.competitorQuery || '');

  // Actions
  var actions = Array.isArray(r.actions) ? r.actions : [];

  // Score label
  var scoreLabel = score >= 76 ? 'Chosen. The default option in your category.'
    : score >= 56 ? 'Considered. Not consistently chosen.'
    : score >= 31 ? 'Seen. Not selected.'
    : 'Not seen. Not chosen.';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>CHOIVE· Report — ${bizName}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Inter:wght@300;400;500;600;700&display=swap');
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Inter',sans-serif;font-size:13px;color:#0C0C0E;background:#fff;max-width:800px;margin:0 auto;}

/* COVER */
.cover{background:#0C0C0E;padding:64px 56px 56px;position:relative;page-break-after:always;}
.cover-top-line{position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,transparent,#C9A86A 30%,#C9A86A 70%,transparent);}
.cover-logo{font-size:14px;font-weight:700;letter-spacing:0.14em;color:rgba(245,242,238,0.3);margin-bottom:64px;}
.cover-logo span{color:#C9A86A;}
.cover-tag{font-size:10px;font-weight:700;letter-spacing:0.28em;text-transform:uppercase;color:#C9A86A;margin-bottom:20px;}
.cover-h1{font-family:'Libre Baskerville',serif;font-size:44px;font-weight:400;color:#F5F2EE;line-height:1.1;letter-spacing:-0.02em;margin-bottom:16px;}
.cover-h1 em{font-style:italic;color:rgba(245,242,238,0.35);}
.cover-sub{font-size:14px;color:rgba(245,242,238,0.4);line-height:1.7;max-width:480px;margin-bottom:64px;}
.cover-meta{display:flex;justify-content:space-between;align-items:flex-end;padding-top:32px;border-top:1px solid rgba(245,242,238,0.08);}
.cover-biz{font-size:13px;color:rgba(245,242,238,0.5);line-height:1.6;}
.cover-biz strong{color:rgba(245,242,238,0.8);font-weight:600;display:block;font-size:15px;margin-bottom:2px;}
.cover-date{font-size:11px;color:rgba(245,242,238,0.25);text-align:right;}

/* SCORE PAGE */
.score-page{padding:56px;page-break-after:always;}
.section-eyebrow{font-size:9px;font-weight:700;letter-spacing:0.26em;text-transform:uppercase;color:#BBBBC2;margin-bottom:20px;}
.score-grid{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-bottom:40px;}
.score-num-block{}
.score-big{font-family:'Libre Baskerville',serif;font-size:120px;font-weight:700;color:#0C0C0E;line-height:0.9;letter-spacing:-0.05em;}
.score-denom{font-size:14px;color:#BBBBC2;letter-spacing:0.08em;margin-top:8px;}
.score-label{font-size:12px;font-weight:600;color:#48484F;margin-top:16px;padding-top:16px;border-top:1px solid rgba(12,12,14,0.08);}
.verdict-block{}
.verdict-tag{display:inline-block;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;padding:5px 12px;border:1px solid rgba(12,12,14,0.15);margin-bottom:16px;color:#48484F;}
.verdict-headline{font-family:'Libre Baskerville',serif;font-size:26px;font-weight:400;color:#0C0C0E;line-height:1.2;margin-bottom:20px;letter-spacing:-0.01em;}
.verdict-summary{font-size:14px;color:#48484F;line-height:1.85;}

/* SCORE BAR */
.score-bar-track{height:2px;background:rgba(12,12,14,0.08);margin-bottom:48px;}
.score-bar-fill{height:100%;background:#C9A86A;}

/* PILLARS */
.pillars-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:0;border:1px solid rgba(12,12,14,0.08);margin-bottom:40px;}
.pillar-cell{padding:24px 20px;border-right:1px solid rgba(12,12,14,0.08);}
.pillar-cell:last-child{border-right:none;}
.pillar-name{font-size:9px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:#BBBBC2;margin-bottom:10px;}
.pillar-score{font-family:'Libre Baskerville',serif;font-size:36px;font-weight:400;color:#0C0C0E;line-height:1;}
.pillar-den{font-size:11px;color:#BBBBC2;}
.pillar-bar{height:2px;background:rgba(12,12,14,0.08);margin:10px 0 8px;}
.pillar-bar-fill{height:100%;background:#C9A86A;}
.pillar-finding{font-size:11px;color:#67676E;line-height:1.5;}

/* DEEP DIVE */
.deep-dive{margin-bottom:48px;}
.pillar-deep{padding:28px 0;border-bottom:1px solid rgba(12,12,14,0.06);}
.pillar-deep:last-child{border-bottom:none;}
.pillar-deep-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid rgba(12,12,14,0.06);}
.pillar-deep-name{font-size:10px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:#BBBBC2;}
.pillar-deep-score{font-family:'Libre Baskerville',serif;font-size:22px;font-weight:400;color:#0C0C0E;}
.pillar-deep-score span{font-size:11px;font-family:'Inter',sans-serif;color:#BBBBC2;}
.pillar-deep-analysis{font-size:13px;color:#48484F;line-height:1.8;margin-bottom:10px;}
.pillar-deep-evidence{font-size:12px;color:#67676E;line-height:1.7;padding:12px 16px;background:#F5F2EE;border-left:2px solid #C9A86A;font-style:italic;}

/* COMPETITOR */
.competitor-section{background:#0C0C0E;padding:40px 48px;margin-bottom:48px;position:relative;}
.competitor-section::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:#C9A86A;}
.competitor-label{font-size:9px;font-weight:700;letter-spacing:0.24em;text-transform:uppercase;color:rgba(201,168,106,0.5);margin-bottom:8px;}
.competitor-name{font-family:'Libre Baskerville',serif;font-size:32px;font-weight:400;font-style:italic;color:#F5F2EE;margin-bottom:4px;}
.competitor-query{font-size:11px;color:rgba(245,242,238,0.3);margin-bottom:16px;font-style:italic;}
.competitor-why{font-size:13px;color:rgba(245,242,238,0.5);line-height:1.8;}

/* PLATFORMS */
.platforms-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:0;border:1px solid rgba(12,12,14,0.08);margin-bottom:48px;}
.platform-cell{padding:20px;text-align:center;border-right:1px solid rgba(12,12,14,0.08);}
.platform-cell:last-child{border-right:none;}
.platform-name{font-size:9px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#BBBBC2;margin-bottom:8px;}
.platform-status{font-size:12px;font-weight:700;letter-spacing:0.06em;margin-bottom:6px;}
.platform-detail{font-size:11px;color:#BBBBC2;line-height:1.5;}

/* ACTIONS */
.actions-section{margin-bottom:48px;}
.action-row{display:flex;gap:16px;padding:20px 0;border-bottom:1px solid rgba(12,12,14,0.06);align-items:flex-start;}
.action-row:last-child{border-bottom:none;}
.action-badge{font-size:8px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;padding:4px 8px;border:1px solid;white-space:nowrap;flex-shrink:0;margin-top:2px;}
.action-badge.critical{color:#B83232;border-color:rgba(184,50,50,0.3);}
.action-badge.high{color:#9A6A14;border-color:rgba(154,106,20,0.3);}
.action-badge.medium{color:#67676E;border-color:rgba(12,12,14,0.15);}
.action-title{font-size:13px;font-weight:600;color:#0C0C0E;margin-bottom:4px;}
.action-body{font-size:12px;color:#48484F;line-height:1.75;}
.action-exp{font-size:11px;color:#BBBBC2;line-height:1.6;margin-top:6px;padding-top:6px;border-top:1px solid rgba(12,12,14,0.04);}

/* SECTION DIVIDER */
.section-divider{margin:48px 0 32px;padding-bottom:12px;border-bottom:1px solid rgba(12,12,14,0.08);display:flex;align-items:center;gap:16px;}
.section-divider-label{font-size:9px;font-weight:700;letter-spacing:0.26em;text-transform:uppercase;color:#BBBBC2;white-space:nowrap;}
.section-divider-line{flex:1;height:1px;background:rgba(12,12,14,0.06);}

/* EVIDENCE */
.evidence-section{margin-bottom:48px;}
.evidence-text{font-size:14px;color:#48484F;line-height:1.9;}

/* FOOTER */
.report-footer{padding:24px 56px;background:#0C0C0E;display:flex;justify-content:space-between;align-items:center;margin-top:64px;}
.footer-logo{font-size:12px;font-weight:700;letter-spacing:0.12em;color:rgba(245,242,238,0.2);}
.footer-logo span{color:rgba(201,168,106,0.4);}
.footer-note{font-size:10px;color:rgba(245,242,238,0.2);}

@media print {
  body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  .cover{page-break-after:always;}
  .score-page{page-break-after:always;}
  .section-divider{page-break-before:auto;}
}
</style>
</head>
<body>

<!-- COVER PAGE -->
<div class="cover">
  <div class="cover-top-line"></div>
  <div class="cover-logo">CHOIVE<span>·</span></div>
  <div class="cover-tag">AI Selection Report</div>
  <div class="cover-h1">Your business.<br><em>Seen by AI.</em></div>
  <div class="cover-sub">A complete diagnostic of your AI selection position — scored, evidenced, and precisely actioned. Everything AI sees when someone asks for your category.</div>
  <div class="cover-meta">
    <div class="cover-biz">
      <strong>${bizName}</strong>
      ${category}${city ? ' · ' + city : ''}${website ? '<br><span style="font-size:11px;color:rgba(245,242,238,0.25);">' + website + '</span>' : ''}
    </div>
    <div class="cover-date">
      ${date}<br>
      <span style="color:rgba(245,242,238,0.15);">Confidential</span>
    </div>
  </div>
</div>

<!-- SCORE PAGE -->
<div class="score-page">
  <div class="section-eyebrow">CHOIVE Index™ — Overall Score</div>
  <div class="score-grid">
    <div class="score-num-block">
      <div class="score-big">${score}</div>
      <div class="score-denom">/ 100</div>
      <div class="score-label">${scoreLabel}</div>
    </div>
    <div class="verdict-block">
      <div class="verdict-tag">Verdict</div>
      <div class="verdict-headline">${verdict}</div>
      <div class="verdict-summary">${summary}</div>
    </div>
  </div>
  <div class="score-bar-track">
    <div class="score-bar-fill" style="width:${score}%"></div>
  </div>

  <!-- PILLARS OVERVIEW -->
  <div class="section-eyebrow">Score breakdown</div>
  <div class="pillars-grid">
    <div class="pillar-cell">
      <div class="pillar-name">Clarity</div>
      <div class="pillar-score">${cl} <span class="pillar-den">/ 25</span></div>
      <div class="pillar-bar"><div class="pillar-bar-fill" style="width:${pct(cl,25)}%"></div></div>
      <div class="pillar-finding">${esc(pillarFinding(r,'clarity'))}</div>
    </div>
    <div class="pillar-cell">
      <div class="pillar-name">Trust</div>
      <div class="pillar-score">${tr} <span class="pillar-den">/ 25</span></div>
      <div class="pillar-bar"><div class="pillar-bar-fill" style="width:${pct(tr,25)}%"></div></div>
      <div class="pillar-finding">${esc(pillarFinding(r,'trust'))}</div>
    </div>
    <div class="pillar-cell">
      <div class="pillar-name">Difference</div>
      <div class="pillar-score">${di} <span class="pillar-den">/ 25</span></div>
      <div class="pillar-bar"><div class="pillar-bar-fill" style="width:${pct(di,25)}%"></div></div>
      <div class="pillar-finding">${esc(pillarFinding(r,'difference'))}</div>
    </div>
    <div class="pillar-cell">
      <div class="pillar-name">Ease</div>
      <div class="pillar-score">${ea} <span class="pillar-den">/ 25</span></div>
      <div class="pillar-bar"><div class="pillar-bar-fill" style="width:${pct(ea,25)}%"></div></div>
      <div class="pillar-finding">${esc(pillarFinding(r,'ease'))}</div>
    </div>
  </div>

  <!-- EVIDENCE NARRATIVE -->
  <div class="section-divider">
    <div class="section-divider-label">Diagnostic evidence</div>
    <div class="section-divider-line"></div>
  </div>
  <div class="evidence-section">
    <div class="evidence-text">${evidence}</div>
  </div>
</div>

<!-- MAIN CONTENT PAGE -->
<div style="padding:56px;">

  <!-- PILLAR DEEP DIVE -->
  <div class="section-divider">
    <div class="section-divider-label">Pillar analysis</div>
    <div class="section-divider-line"></div>
  </div>
  <div class="deep-dive">
    ${['clarity','trust','difference','ease'].map(function(key) {
      var names = {clarity:'Clarity',trust:'Trust',difference:'Difference',ease:'Ease'};
      var sc = pillarScore(r,key);
      var an = pillarAnalysis(r,key);
      var ev = pillarEvidence(r,key);
      return '<div class="pillar-deep">'
        + '<div class="pillar-deep-head">'
        + '<div class="pillar-deep-name">' + names[key] + '</div>'
        + '<div class="pillar-deep-score">' + sc + '<span> / 25</span></div>'
        + '</div>'
        + (an ? '<div class="pillar-deep-analysis">' + esc(an) + '</div>' : '')
        + (ev ? '<div class="pillar-deep-evidence">' + esc(ev) + '</div>' : '')
        + '</div>';
    }).join('')}
  </div>

  <!-- COMPETITOR -->
  ${compName ? `
  <div class="section-divider">
    <div class="section-divider-label">Competitor intelligence</div>
    <div class="section-divider-line"></div>
  </div>
  <div class="competitor-section">
    <div class="competitor-label">Being recommended instead of you</div>
    <div class="competitor-name">${compName}</div>
    ${compQuery ? '<div class="competitor-query">On queries like: "' + compQuery + '"</div>' : ''}
    ${compWhy ? '<div class="competitor-why">' + compWhy + '</div>' : ''}
  </div>` : ''}

  <!-- PLATFORM COVERAGE -->
  <div class="section-divider">
    <div class="section-divider-label">Platform coverage</div>
    <div class="section-divider-line"></div>
  </div>
  <div class="platforms-grid">
    ${platforms.map(function(p) {
      var data = pc[p] || { status:'absent', detail:'Not found' };
      var colour = statusColour(data.status);
      return '<div class="platform-cell">'
        + '<div class="platform-name">' + platformNames[p] + '</div>'
        + '<div class="platform-status" style="color:' + colour + '">' + statusLabel(data.status) + '</div>'
        + '<div class="platform-detail">' + esc(data.detail || '') + '</div>'
        + '</div>';
    }).join('')}
  </div>

  <!-- PRIORITY ACTIONS -->
  <div class="section-divider">
    <div class="section-divider-label">Priority actions</div>
    <div class="section-divider-line"></div>
  </div>
  <div class="actions-section">
    ${actions.map(function(a) {
      if (!a) return '';
      var p = (a.priority || 'medium').toLowerCase();
      return '<div class="action-row">'
        + '<div class="action-badge ' + p + '">' + p.toUpperCase() + '</div>'
        + '<div>'
        + '<div class="action-title">' + esc(a.title || '') + '</div>'
        + '<div class="action-body">' + esc(a.body || '') + '</div>'
        + (a.explanation ? '<div class="action-exp">' + esc(a.explanation) + '</div>' : '')
        + '</div>'
        + '</div>';
    }).join('')}
  </div>

</div>

<!-- FOOTER -->
<div class="report-footer">
  <div class="footer-logo">CHOIVE<span>·</span></div>
  <div class="footer-note">AI Selection Report · choive.com · ${date} · Confidential</div>
</div>

</body>
</html>`;
}

// ── SEND REPORT EMAIL ─────────────────────────────────────────────────────────
async function sendReportEmail(customerEmail, bizName, reportHTML, jobId) {
  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) throw new Error('RESEND_API_KEY not configured');

  var siteUrl = (process.env.URL || 'https://choive.com').replace(/\/$/, '');
  var resultUrl = siteUrl + '/?jobId=' + encodeURIComponent(jobId);

  var res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + resendKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'CHOIVE· <hello@choive.com>',
      to: [customerEmail],
      subject: 'Your CHOIVE· Report — ' + bizName,
      html: [
        '<div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;padding:48px 24px;color:#0C0C0E;">',
        '<div style="font-size:16px;font-weight:700;letter-spacing:0.1em;margin-bottom:40px;">',
        'CHOIVE<span style="color:#C9A86A;">·</span>',
        '</div>',
        '<h1 style="font-family:Georgia,serif;font-size:28px;font-weight:400;font-style:italic;margin:0 0 16px;line-height:1.2;color:#0C0C0E;">',
        'Your AI Selection Report is ready.',
        '</h1>',
        '<p style="font-size:14px;line-height:1.85;color:#48484F;margin:0 0 32px;">',
        'Your complete CHOIVE Report for <strong>' + bizName + '</strong> is attached to this email as a PDF.',
        ' It includes your full score breakdown, competitor intelligence, platform coverage, priority actions, and 30-day implementation plan.',
        '</p>',
        '<div style="background:#F5F2EE;padding:24px 28px;margin-bottom:32px;border-left:3px solid #C9A86A;">',
        '<div style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#BBBBC2;margin-bottom:8px;">What\'s inside</div>',
        '<div style="font-size:13px;color:#48484F;line-height:1.8;">',
        '→ Executive summary & overall score<br>',
        '→ Four pillar breakdown with evidence<br>',
        '→ Competitor intelligence<br>',
        '→ Platform coverage — ChatGPT, Perplexity, Gemini, Claude<br>',
        '→ Priority actions with implementation detail<br>',
        '→ Your online result with shareable link',
        '</div>',
        '</div>',
        '<a href="' + resultUrl + '" style="display:inline-block;background:#C9A86A;color:#0C0C0E;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:0.06em;padding:14px 28px;margin-bottom:32px;">',
        'View Your Online Result →',
        '</a>',
        '<p style="font-size:12px;color:#BBBBC2;line-height:1.7;margin:0;padding-top:24px;border-top:1px solid #EDEAE5;">',
        'Questions about your report? Reply to this email or contact ',
        '<a href="mailto:hello@choive.com" style="color:#C9A86A;text-decoration:none;">hello@choive.com</a><br>',
        'CHOIVE· — Be the answer. Not the alternative.',
        '</p>',
        '</div>'
      ].join(''),
      attachments: [
        {
          filename: 'CHOIVE-Report-' + bizName.replace(/[^a-zA-Z0-9]/g, '-') + '.html',
          content: Buffer.from(reportHTML).toString('base64'),
          content_type: 'text/html'
        }
      ]
    })
  });

  if (!res.ok) {
    var err = await res.json();
    throw new Error('Resend failed: ' + JSON.stringify(err));
  }

  return await res.json();
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  var body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  var jobId         = String(body.jobId || '').trim();
  var customerEmail = String(body.email || '').trim();

  if (!jobId) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing jobId' })
    };
  }
  if (!customerEmail || !customerEmail.includes('@')) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing or invalid email' })
    };
  }

  console.log('generate-report: starting for jobId', jobId, 'email', customerEmail);

  // 1. Fetch diagnostic from Supabase
  var diagnostic;
  try {
    diagnostic = await getDiagnostic(jobId);
  } catch (err) {
    console.error('generate-report: getDiagnostic failed:', err.message);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not fetch diagnostic: ' + err.message })
    };
  }

  if (!diagnostic) {
    return {
      statusCode: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Diagnostic not found for jobId: ' + jobId })
    };
  }

  if (diagnostic.status !== 'complete') {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Diagnostic not complete. Status: ' + diagnostic.status })
    };
  }

  // 2. Build report HTML
  var reportHTML;
  try {
    reportHTML = buildReportHTML(diagnostic);
    console.log('generate-report: HTML built, length:', reportHTML.length);
  } catch (err) {
    console.error('generate-report: buildReportHTML failed:', err.message);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to build report: ' + err.message })
    };
  }

  // 3. Email report
  var bizName = (diagnostic.input && diagnostic.input.name) || 'Your Business';
  try {
    await sendReportEmail(customerEmail, bizName, reportHTML, jobId);
    console.log('generate-report: report emailed to', customerEmail);
  } catch (err) {
    console.error('generate-report: email failed:', err.message);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to send report email: ' + err.message })
    };
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: true,
      message: 'Report generated and emailed to ' + customerEmail,
      jobId: jobId
    })
  };
};
