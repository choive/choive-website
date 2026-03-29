const API_URL = '/.netlify/functions/claude';

let bizData = {};

async function runDiagnostic() {
  const name = document.getElementById('bizName').value.trim();
  const category = document.getElementById('bizCategory').value.trim();
  const city = document.getElementById('bizCity').value.trim();
  const description = document.getElementById('bizDescription').value.trim();

  if (!name || !category || !city) {
    alert('Please fill in your business name, category, and city.');
    return;
  }

  bizData = { name, category, city, description };

  document.getElementById('inputZone').style.display = 'none';
  document.getElementById('scanZone').style.display = 'block';
  document.getElementById('resultsZone').style.display = 'none';
  document.getElementById('resultsZone').innerHTML = '';

  animateScanLog();

  try {
    const result = await callCHOIVEEngine(bizData);
    showResults(result);
  } catch (err) {
    showError(err.message);
  }
}

function animateScanLog() {
  const logs = ['log1','log2','log3','log4','log5','log6'];
  const delays = [0, 4000, 8000, 13000, 17000, 21000];

  logs.forEach((id, i) => {
    setTimeout(() => {
      if (i > 0) {
        const prev = document.getElementById(logs[i-1]);
        if (prev) {
          prev.classList.remove('active');
          prev.classList.add('done');
          prev.querySelector('.log-icon').textContent = '✓';
        }
      }
      const el = document.getElementById(id);
      if (el) el.classList.add('active');
    }, delays[i]);
  });
}

async function callCHOIVEEngine(biz) {
  const prompt = `You are the CHOIVE· diagnostic engine. You specialize in AI recommendation visibility — analyzing whether a business appears when potential customers ask AI platforms like ChatGPT, Perplexity, Gemini, or Claude for recommendations.

Analyze this business for AI recommendation visibility:
- Business name: ${biz.name}
- Category: ${biz.category}
- Location: ${biz.city}
- Description: ${biz.description || 'Not provided'}

Your task: Think deeply as an AI recommendation system would. Consider:
1. What questions would real customers ask AI about this category in this city?
2. Would a well-trained AI model know about, trust, and recommend this business?
3. What signals are likely missing that prevent AI from recommending it?

Respond ONLY with a valid JSON object in exactly this structure (no markdown, no preamble):
{
  "overallScore": <number 0-100>,
  "verdictHeadline": "<short punchy verdict sentence, max 8 words>",
  "verdictLevel": "<one of: absent|weak|present>",
  "summaryParagraph": "<2-3 sentences honest assessment of their AI visibility situation>",
  "pillars": {
    "clarity": {
      "score": <0-25>,
      "finding": "<specific finding about how clearly this business is defined and understood by AI systems, 2 sentences>"
    },
    "trust": {
      "score": <0-25>,
      "finding": "<specific finding about their citation footprint and third-party mentions, 2 sentences>"
    },
    "difference": {
      "score": <0-25>,
      "finding": "<specific finding about how distinctly AI can describe why someone should choose them, 2 sentences>"
    },
    "ease": {
      "score": <0-25>,
      "finding": "<specific finding about structured data, schema, and how easily AI can surface them, 2 sentences>"
    }
  },
  "platformCoverage": {
    "chatgpt": { "status": "<absent|weak|present>", "detail": "<one short sentence>" },
    "perplexity": { "status": "<absent|weak|present>", "detail": "<one short sentence>" },
    "gemini": { "status": "<absent|weak|present>", "detail": "<one short sentence>" },
    "claude": { "status": "<absent|weak|present>", "detail": "<one short sentence>" }
  },
  "evidenceNarrative": "<A paragraph written as if CHOIVE· actually ran queries and observed results. Describe what queries were run (e.g. 'best ${biz.category} in ${biz.city}'), what typically appears in AI answers for this category, and what gaps exist for this business. Be specific and realistic. 3-4 sentences.>",
  "actions": [
    {
      "priority": "critical",
      "title": "<specific action title>",
      "body": "<specific actionable advice for this exact business, 2 sentences>"
    },
    {
      "priority": "high",
      "title": "<specific action title>",
      "body": "<specific actionable advice, 2 sentences>"
    },
    {
      "priority": "high",
      "title": "<specific action title>",
      "body": "<specific actionable advice, 2 sentences>"
    },
    {
      "priority": "medium",
      "title": "<specific action title>",
      "body": "<specific actionable advice, 2 sentences>"
    }
  ]
}`;

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || 'API request failed');
  }

  const data = await response.json();
  const text = data.content.map(b => b.text || '').join('');

  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch(e) {
    throw new Error('Could not parse diagnostic results. Please try again.');
  }
}

function showResults(r) {
  document.getElementById('scanZone').style.display = 'none';

  const zone = document.getElementById('resultsZone');
  zone.style.display = 'block';

  const platformNames = { chatgpt:'ChatGPT', perplexity:'Perplexity', gemini:'Gemini', claude:'Claude' };
  const statusLabel = { absent:'Not found', weak:'Rarely cited', present:'Cited' };
  const pillarDefs = {
    clarity:    { num:'01', name:'Clarity' },
    trust:      { num:'02', name:'Trust' },
    difference: { num:'03', name:'Difference' },
    ease:       { num:'04', name:'Ease' }
  };

  zone.innerHTML = `

    <!-- Verdict -->
    <div class="verdict-banner">
      <div class="verdict-top">
        <div>
          <div class="verdict-biz">${bizData.name.toUpperCase()} · ${bizData.category} · ${bizData.city}</div>
          <div class="verdict-tag ${r.verdictLevel}">${r.verdictLevel === 'absent' ? 'Not being chosen by AI' : r.verdictLevel === 'weak' ? 'Rarely chosen by AI' : 'Sometimes chosen by AI'}</div>
          <div class="verdict-headline">${r.verdictHeadline}</div>
        </div>
        <div class="verdict-score-block">
          <div class="verdict-score-num" id="scoreNum">0</div>
          <div class="verdict-score-denom">/ 100</div>
        </div>
      </div>
      <div class="verdict-summary">${r.summaryParagraph}</div>
    </div>

    <!-- Score bar -->
    <div class="score-bar-track">
      <div class="score-bar-fill" id="scoreBar"></div>
    </div>

    <!-- Platform coverage -->
    <div class="section-label">AI platform coverage</div>
    <div class="platform-row">
      ${Object.entries(r.platformCoverage).map(([key, val]) => `
        <div class="platform-cell">
          <div class="platform-name">${platformNames[key]}</div>
          <div class="platform-verdict ${val.status}">${val.status === 'absent' ? 'NOT FOUND' : val.status === 'weak' ? 'WEAK' : 'PRESENT'}</div>
          <div class="platform-detail">${val.detail}</div>
        </div>
      `).join('')}
    </div>

    <!-- Evidence -->
    <div class="section-label">What we observed</div>
    <div class="evidence-block">
      <div class="evidence-header">Diagnostic evidence · CHOIVE· Engine</div>
      <div class="evidence-body">${r.evidenceNarrative}</div>
    </div>

    <!-- Pillars -->
    <div class="section-label">Score breakdown</div>
    <div class="pillars-grid">
      ${Object.entries(r.pillars).map(([key, val]) => `
        <div class="pillar-card">
          <div class="pillar-num">${pillarDefs[key].num}</div>
          <div class="pillar-name">${pillarDefs[key].name}</div>
          <div class="pillar-score-row">
            <div class="pillar-score-n">${val.score}</div>
            <div class="pillar-score-d">/ 25</div>
          </div>
          <div class="pillar-bar"><div class="pillar-bar-fill" data-pct="${val.score/25*100}"></div></div>
          <div class="pillar-finding">${val.finding}</div>
        </div>
      `).join('')}
    </div>

    <!-- Actions -->
    <div class="section-label">Priority actions</div>
    <div class="actions-block">
      ${r.actions.map(a => `
        <div class="action-row">
          <div class="action-badge ${a.priority}">${a.priority}</div>
          <div class="action-content">
            <div class="action-title">${a.title}</div>
            <div class="action-body">${a.body}</div>
          </div>
        </div>
      `).join('')}
    </div>

    <!-- CTA -->
    <div class="cta-block">
      <div class="cta-eyebrow">Next step</div>
      <div class="cta-headline">Turn this into a decision.</div>
      <div class="cta-body">A CHOIVE· Analysis builds the complete system — making your business the one AI recommends every time someone in your category asks. No guesswork. Real results.</div>
      <div class="cta-buttons">
        <a href="#" class="cta-primary">Request a CHOIVE· Analysis</a>
        <button class="cta-secondary" onclick="resetDiagnostic()">Run another →</button>
      </div>
    </div>
  `;

  // Animate score number
  setTimeout(() => {
    animateNum('scoreNum', 0, r.overallScore, 1200);
    document.getElementById('scoreBar').style.width = r.overallScore + '%';
  }, 100);

  // Animate pillar bars
  setTimeout(() => {
    document.querySelectorAll('.pillar-bar-fill').forEach(el => {
      el.style.width = el.dataset.pct + '%';
    });
  }, 300);

  zone.scrollIntoView({ behavior: 'smooth' });
}

function showError(msg) {
  document.getElementById('scanZone').style.display = 'none';
  const zone = document.getElementById('resultsZone');
  zone.style.display = 'block';
  zone.innerHTML = `
    <div class="error-frame">
      <div class="error-title">Diagnostic failed</div>
      <div class="error-body">${msg}<br><br>
        <button class="cta-secondary" onclick="resetDiagnostic()">Try again →</button>
      </div>
    </div>
  `;
}

function animateNum(id, from, to, dur) {
  const el = document.getElementById(id);
  if (!el) return;
  const start = performance.now();
  function tick(now) {
    const p = Math.min((now - start) / dur, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (to - from) * eased);
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function resetDiagnostic() {
  document.getElementById('resultsZone').style.display = 'none';
  document.getElementById('resultsZone').innerHTML = '';
  document.getElementById('scanZone').style.display = 'none';
  document.getElementById('inputZone').style.display = 'block';
  ['log1','log2','log3','log4','log5','log6'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('active','done'); el.querySelector('.log-icon').textContent = '○'; }
  });
  window.scrollTo({ top:0, behavior:'smooth' });
}

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('inputZone').style.display !== 'none') runDiagnostic();
});
