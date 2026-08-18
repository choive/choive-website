// generate-fix-copy.js
// Uses Claude to generate ready-to-use copy for a specific fix action
// POST { jobId, actionTitle, businessContext }
// ENV: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { realtime: { transport: ws } });
}

async function callClaude(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
  
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1200,
      temperature: 0.7,
      messages: [{
        role: 'user',
        content: prompt
      }]
    })
  });
  
  if (!response.ok) {
    const err = await response.text();
    throw new Error('Claude API error: ' + err);
  }
  
  const data = await response.json();
  return data.content[0].text;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }
  
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }
  
  const { jobId, actionTitle, fixType } = body;
  
  if (!jobId || !actionTitle) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing jobId or actionTitle' })
    };
  }
  
  try {
    // Fetch the diagnostic result to get business context
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('diagnostics')
      .select('result, input, paid')
      .eq('job_id', jobId)
      .eq('status', 'complete')
      .single();
    
    if (error || !data) {
      return {
        statusCode: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Diagnostic not found' })
      };
    }
    
    // Only allow for paid diagnostics
    if (!data.paid) {
      return {
        statusCode: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'This feature is only available for paid diagnostics' })
      };
    }
    
    const result = data.result;
    const input = data.input;
    const businessName = input.name || 'the business';
    const category = result.inferredCategory || input.category || 'this category';
    const website = input.website || '';
    
    // Build context-aware prompt based on fix type
    let prompt = '';
    
    if (fixType === 'difference_page') {
      prompt = `You are a professional copywriter helping ${businessName}, a business in ${category}.

They need to create a "What makes us different" page on their website (${website}) to help potential customers understand their unique value.

Based on what you know:
- Business: ${businessName}
- Category: ${category}
- Description: ${input.description || 'Not provided'}

Write clear, compelling copy for a "What Makes Us Different" page. The copy should:
1. Start with a clear headline
2. List 3-4 specific differentiators (not generic claims like "quality" or "service")
3. Use simple language a 5-year-old could understand
4. Be under 300 words
5. Sound authentic and factual, not marketing fluff

Format as plain text, ready to paste into a website.`;
    } else if (fixType === 'about_proof') {
      prompt = `You are a professional copywriter helping ${businessName}, a business in ${category}.

Their "About" page needs more concrete proof and specifics to help customers trust them.

Based on what you know:
- Business: ${businessName}
- Category: ${category}
- Description: ${input.description || 'Not provided'}

Write 2-3 short paragraphs (under 200 words total) they can add to their About page that include:
1. When they started (if known, otherwise suggest they add it)
2. A specific, measurable fact about what they do
3. Who they serve (be specific)

Use simple language. No marketing fluff. Just clear facts.`;
    } else if (fixType === 'review_prompt') {
      prompt = `You are a professional copywriter helping ${businessName}, a business in ${category}.

They need to ask happy customers for reviews but don't know what to say.

Write a SHORT, friendly email (under 100 words) they can send to a recent customer asking for an honest review. It should:
1. Thank them for their business
2. Politely ask for a review
3. Include a placeholder [REVIEW_LINK] where they'll paste the review platform link
4. Sound warm and genuine, not salesy
5. Use simple words a 5-year-old would understand

Format as plain text, ready to copy and paste.`;
    } else {
      // Generic fix copy
      prompt = `You are a professional copywriter helping ${businessName}, a business in ${category}.

They need help with this task: ${actionTitle}

Based on what you know:
- Business: ${businessName}
- Category: ${category}
- Website: ${website}
- Description: ${input.description || 'Not provided'}

Write clear, simple copy or guidance (under 250 words) to help them complete this task. Use language a 5-year-old could understand. Be specific and actionable.`;
    }
    
    const generatedCopy = await callClaude(prompt);
    
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        copy: generatedCopy,
        actionTitle
      })
    };
  } catch (err) {
    console.error('generate-fix-copy error:', err);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to generate copy: ' + err.message })
    };
  }
};
