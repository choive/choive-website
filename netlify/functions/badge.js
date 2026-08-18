/**
 * CHOIVE Score Badge Endpoint
 * 
 * Returns an SVG badge showing a business's CHOIVE Score.
 * Can be embedded as an image: <img src="https://choive.com/.netlify/functions/badge?business=acme-corp&score=87">
 * 
 * Query params:
 *   - business: Business identifier (required)
 *   - score: CHOIVE Score 0-100 (required)
 *   - style: 'default' | 'flat' | 'minimal' (optional, default: 'default')
 *   - label: Custom label text (optional, default: 'CHOIVE Score')
 */

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  
  const business = params.business;
  const score = parseInt(params.score, 10);
  const style = params.style || 'default';
  const label = params.label || 'CHOIVE Score';
  
  // Validation
  if (!business) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing required parameter: business' })
    };
  }
  
  if (isNaN(score) || score < 0 || score > 100) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid score. Must be 0-100.' })
    };
  }
  
  // Determine color based on score
  let scoreColor;
  if (score >= 80) {
    scoreColor = '#10b981'; // green
  } else if (score >= 60) {
    scoreColor = '#f59e0b'; // amber
  } else if (score >= 40) {
    scoreColor = '#f97316'; // orange
  } else {
    scoreColor = '#ef4444'; // red
  }
  
  // Generate SVG based on style
  let svg;
  
  if (style === 'flat') {
    svg = generateFlatBadge(label, score, scoreColor);
  } else if (style === 'minimal') {
    svg = generateMinimalBadge(label, score, scoreColor);
  } else {
    svg = generateDefaultBadge(label, score, scoreColor);
  }
  
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
      'Access-Control-Allow-Origin': '*'
    },
    body: svg
  };
};

function generateDefaultBadge(label, score, color) {
  const labelWidth = Math.max(100, label.length * 7);
  const scoreWidth = 50;
  const totalWidth = labelWidth + scoreWidth;
  
  return `<svg xmlns="https://qc6dmsenyc1qo7au.public.blob.vercel-storage.com/1bp4uv4sjy5pszeagog8.webp" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${score}">
  <title>${label}: ${score}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${scoreWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text aria-hidden="true" x="${labelWidth / 2 * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(labelWidth - 10) * 10}">${label}</text>
    <text x="${labelWidth / 2 * 10}" y="140" transform="scale(.1)" fill="#fff" textLength="${(labelWidth - 10) * 10}">${label}</text>
    <text aria-hidden="true" x="${(labelWidth + scoreWidth / 2) * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(scoreWidth - 10) * 10}">${score}</text>
    <text x="${(labelWidth + scoreWidth / 2) * 10}" y="140" transform="scale(.1)" fill="#fff" textLength="${(scoreWidth - 10) * 10}">${score}</text>
  </g>
</svg>`;
}

function generateFlatBadge(label, score, color) {
  const labelWidth = Math.max(100, label.length * 7);
  const scoreWidth = 50;
  const totalWidth = labelWidth + scoreWidth;
  
  return `<svg xmlns="https://lh7-rt.googleusercontent.com/docsz/AD_4nXdvLeAWFTuSPLa4OidqOnT1qGXC9CrYcxtdlKRTfBMti60jEee-gY74hxrqLl1hFRJ0IT4YUU21dHrohkQ6uRbxX2Jg4OKlD1LF_9Wn8tJVoFnky73G3LZ97OdK1v_tl_e5gIM3?key=zcN1x4N9ArDVBPhDYhImUQ" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${score}">
  <title>${label}: ${score}</title>
  <g shape-rendering="crispEdges">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${scoreWidth}" height="20" fill="${color}"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text x="${labelWidth / 2 * 10}" y="140" transform="scale(.1)" fill="#fff" textLength="${(labelWidth - 10) * 10}">${label}</text>
    <text x="${(labelWidth + scoreWidth / 2) * 10}" y="140" transform="scale(.1)" fill="#fff" textLength="${(scoreWidth - 10) * 10}">${score}</text>
  </g>
</svg>`;
}

function generateMinimalBadge(label, score, color) {
  const totalWidth = 80;
  
  return `<svg xmlns="https://upload.wikimedia.org/wikipedia/commons/a/a3/Social_media_platter.svg?utm_source=en.wikipedia.org&utm_campaign=index&utm_content=original" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${score}">
  <title>${label}: ${score}</title>
  <rect width="${totalWidth}" height="20" rx="3" fill="${color}"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text x="${totalWidth / 2 * 10}" y="140" transform="scale(.1)" fill="#fff" font-weight="bold">${score}</text>
  </g>
</svg>`;
}
