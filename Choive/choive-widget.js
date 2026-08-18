/**
 * CHOIVE Score Widget — verified embeddable score.
 *
 * A CHOIVE Score is a trust signal, so the widget's primary mode fetches the
 * REAL, current score from CHOIVE by diagnostic id. It cannot be faked by
 * editing the embed code.
 *
 * Verified usage (recommended):
 *   <div id="choive-score" data-job="<diagnostic-id>" data-style="card"></div>
 *   <script src="https://choive.com/choive-widget.js" async></script>
 *
 * Attributes:
 *   data-job    : CHOIVE diagnostic id (VERIFIED — score fetched live from CHOIVE)
 *   data-style  : 'card' | 'badge' | 'inline'  (default: 'card')
 *   data-theme  : 'light' | 'dark'             (default: 'light')
 *   data-link   : 'true' | 'false'             (default: 'true')
 *   data-score  : legacy manual score 0-100 — renders UNVERIFIED (no ✓). Use
 *                 data-job for a real, tamper-proof CHOIVE Score.
 */
(function () {
  'use strict';

  var ORIGIN = (function () {
    try {
      var s = document.currentScript && document.currentScript.src;
      if (s) return new URL(s).origin;
    } catch (e) {}
    return 'https://choive.com';
  })();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    var containers = document.querySelectorAll('[id^="choive-score"]');
    Array.prototype.forEach.call(containers, function (c) { renderWidget(c); });
  }

  function renderWidget(container) {
    var jobId = container.getAttribute('data-job');
    var style = container.getAttribute('data-style') || 'card';
    var theme = container.getAttribute('data-theme') || 'light';
    var shouldLink = container.getAttribute('data-link') !== 'false';

    if (jobId) {
      // VERIFIED path — fetch the real current score from CHOIVE.
      container.innerHTML = skeleton(theme);
      fetchScore(jobId).then(function (data) {
        if (!data || typeof data.score !== 'number') {
          container.innerHTML = errorBox('Score unavailable', theme);
          return;
        }
        paint(container, {
          score: data.score, style: style, theme: theme, shouldLink: shouldLink,
          verified: true, jobId: jobId, name: data.name || ''
        });
      }).catch(function () {
        container.innerHTML = errorBox('Score unavailable', theme);
      });
      return;
    }

    // LEGACY/unverified path — manual score, clearly marked unverified.
    var score = parseInt(container.getAttribute('data-score'), 10);
    if (isNaN(score) || score < 0 || score > 100) {
      console.error('CHOIVE Widget: provide data-job (verified) or a valid data-score 0-100.');
      return;
    }
    paint(container, {
      score: score, style: style, theme: theme, shouldLink: shouldLink,
      verified: false, jobId: null, name: ''
    });
  }

  function fetchScore(jobId) {
    return fetch(ORIGIN + '/.netlify/functions/get-result?jobId=' + encodeURIComponent(jobId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || j.status !== 'complete' || !j.result) return null;
        var s = Math.round(Number(j.result.overallScore));
        if (!(s >= 0 && s <= 100)) return null;
        return { score: s, name: (j.input && j.input.name) || '' };
      });
  }

  function paint(container, o) {
    var m = meta(o.score);
    var link = o.jobId ? (ORIGIN + '/result?jobId=' + encodeURIComponent(o.jobId)) : ORIGIN;
    var html;
    if (o.style === 'badge') html = badgeWidget(o, link);
    else if (o.style === 'inline') html = inlineWidget(o, m, link);
    else html = cardWidget(o, m, link);
    container.innerHTML = html;
  }

  function meta(score) {
    if (score >= 80) return { color: '#10b981', label: 'Excellent', description: 'Strongly recommended by AI platforms' };
    if (score >= 60) return { color: '#f59e0b', label: 'Good', description: 'Generally recommended by AI platforms' };
    if (score >= 40) return { color: '#f97316', label: 'Fair', description: 'Mixed recommendations from AI platforms' };
    return { color: '#ef4444', label: 'Needs Work', description: 'Rarely recommended by AI platforms' };
  }

  function verifiedMark(color) {
    return '<span title="Verified by CHOIVE" style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:700;color:' + color + ';">'
      + '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M9 12l2 2 4-4" stroke="' + color + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" stroke="' + color + '" stroke-width="2"/></svg>'
      + 'VERIFIED</span>';
  }

  function unverifiedMark() {
    return '<span title="Self-reported — not verified by CHOIVE" style="font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:.4px;">UNVERIFIED</span>';
  }

  function cardWidget(o, m, link) {
    var isDark = o.theme === 'dark';
    var bg = isDark ? '#1f2937' : '#ffffff';
    var tx = isDark ? '#f9fafb' : '#111827';
    var sub = isDark ? '#d1d5db' : '#6b7280';
    var bd = isDark ? '#374151' : '#e5e7eb';
    return ''
      + '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif;background:' + bg + ';color:' + tx + ';border:1px solid ' + bd + ';border-radius:8px;padding:20px;max-width:300px;box-shadow:0 1px 3px rgba(0,0,0,.1);">'
      +   '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">'
      +     '<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:' + sub + ';">CHOIVE Score</div>'
      +     '<div style="font-size:32px;font-weight:700;color:' + m.color + ';">' + o.score + '</div>'
      +   '</div>'
      +   '<div style="margin-bottom:8px;">'
      +     '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;"><span style="font-size:16px;font-weight:600;color:' + m.color + ';">' + m.label + '</span>' + (o.verified ? verifiedMark(m.color) : unverifiedMark()) + '</div>'
      +     '<div style="font-size:13px;line-height:1.5;color:' + sub + ';">' + m.description + '</div>'
      +   '</div>'
      +   (o.shouldLink ? '<div style="margin-top:16px;padding-top:16px;border-top:1px solid ' + bd + ';"><a href="' + link + '" target="_blank" rel="noopener" style="font-size:12px;color:' + m.color + ';text-decoration:none;font-weight:500;">' + (o.verified ? 'View verified result →' : 'Measure your real score →') + '</a></div>' : '')
      +   '<div style="margin-top:12px;font-size:10px;color:' + sub + ';">Measured by <a href="' + ORIGIN + '" target="_blank" rel="noopener" style="color:' + sub + ';text-decoration:underline;">CHOIVE</a></div>'
      + '</div>';
  }

  function badgeWidget(o, link) {
    var src = o.jobId
      ? (ORIGIN + '/.netlify/functions/badge?job=' + encodeURIComponent(o.jobId))
      : (ORIGIN + '/.netlify/functions/badge?score=' + o.score); // unverified → endpoint renders "unverified"
    var img = '<img src="' + src + '" alt="CHOIVE Score: ' + o.score + '" style="border:0;">';
    return o.shouldLink ? '<a href="' + link + '" target="_blank" rel="noopener">' + img + '</a>' : img;
  }

  function inlineWidget(o, m, link) {
    return ''
      + '<span style="display:inline-flex;align-items:center;gap:6px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;font-size:14px;font-weight:500;">'
      +   '<span style="color:#6b7280;">CHOIVE Score:</span>'
      +   '<span style="color:' + m.color + ';font-weight:700;">' + o.score + '</span>'
      +   '<span style="color:' + m.color + ';">(' + m.label + ')</span>'
      +   (o.verified ? verifiedMark(m.color) : unverifiedMark())
      +   (o.shouldLink ? '<a href="' + link + '" target="_blank" rel="noopener" style="color:' + m.color + ';text-decoration:none;margin-left:4px;">↗</a>' : '')
      + '</span>';
  }

  function skeleton(theme) {
    var bd = theme === 'dark' ? '#374151' : '#e5e7eb';
    return '<div style="font-family:-apple-system,sans-serif;border:1px solid ' + bd + ';border-radius:8px;padding:20px;max-width:300px;color:#9ca3af;font-size:12px;">Loading CHOIVE Score…</div>';
  }

  function errorBox(msg, theme) {
    var bd = theme === 'dark' ? '#374151' : '#e5e7eb';
    return '<div style="font-family:-apple-system,sans-serif;border:1px solid ' + bd + ';border-radius:8px;padding:16px;max-width:300px;color:#94a3b8;font-size:12px;">' + msg + '</div>';
  }
})();
