const fetchPage = async (url) => {
  try {
    const res = await fetch(url);
    const html = await res.text();
    return html.slice(0, 5000);
  } catch {
    return "";
  }
};

export async function handler(event) {
  try {
    const { query } = JSON.parse(event.body);

    // 🔍 1. GOOGLE SEARCH (REAL DATA)
    const searchRes = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.SERPER_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ q: query, num: 3 })
    });

    const searchData = await searchRes.json();

    // 🌐 2. FETCH WEBSITE CONTENT
    const pages = await Promise.all(
      searchData.organic.map(r => fetchPage(r.link))
    );

    // 🧠 3. AI ANALYSIS (CLAUDE)
const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": process.env.CLAUDE_API_KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json"
  },
  body: JSON.stringify({
    model: "claude-3-sonnet-20240229",
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content: `
You are evaluating how AI systems understand a company across the internet.

Score from 0–25 each:
- Clarity (is it obvious what they do?)
- Trust (do they feel credible and legitimate?)
- Ease (is it easy to understand quickly?)
- Difference (are they clearly distinct?)

Also explain the reasoning clearly.

DATA:
${JSON.stringify(pages).slice(0, 8000)}
        `
      }
    ]
  })
});

const aiData = await aiRes.json();

    // 📊 4. RETURN RESULT
    return {
      statusCode: 200,
      body: JSON.stringify({
        search: searchData,
        analysis: aiData
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
}
