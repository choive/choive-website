exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: 'Method Not Allowed',
    };
  }

  try {
    const body = JSON.parse(event.body);

    const prompt = `
You are CHOIVE™ — a decision intelligence engine.

Analyze this business:

Name: ${body.businessName}
Category: ${body.category}
Location: ${body.location}
Website: ${body.website}

Return a structured diagnostic with:
- Visibility score (0–100)
- Trust score (0–100)
- Clarity score (0–100)
- Positioning score (0–100)
- Short explanation for each
- 3 key weaknesses
- 3 priority fixes
`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 800,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });

    const data = await response.json();

    // ✅ SAFE extraction
    const text =
      data?.content?.[0]?.text ||
      'No response generated';

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ result: text }),
    };
  } catch (error) {
    console.error('CHOIVE ERROR:', error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'CHOIVE engine failed',
        details: error.message,
      }),
    };
  }
};
