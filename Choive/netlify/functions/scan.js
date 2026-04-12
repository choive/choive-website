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

    // 🧠 3. AI ANALYSIS
    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content:
              "You are an AI evaluating how clearly and strongly a business is understood across the internet."
          },
          {
            role: "user",
            content: `
Evaluate this company based on the data below.

Score from 0–25 each:
- Clarity
- Trust
- Ease
- Difference

Also explain why.

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
