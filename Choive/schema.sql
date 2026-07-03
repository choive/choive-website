{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://choive.com/#organization",
      "name": "CHOIVE",
      "url": "https://choive.com",
      "description": "CHOIVE is the AI Selection Intelligence platform — measuring, diagnosing, and closing the gap between where a business is and where AI recommends it.",
      "contactPoint": {
        "@type": "ContactPoint",
        "email": "hello@choive.com",
        "contactType": "customer service"
      },
      "founder": {
        "@type": "Person",
        "name": "Blessing Ashionye Ebogu",
        "jobTitle": "Founder & CEO"
      },
      "logo": "https://choive.com/logo.png"
    },
    {
      "@type": "WebSite",
      "@id": "https://choive.com/#website",
      "url": "https://choive.com",
      "name": "CHOIVE",
      "publisher": {
        "@id": "https://choive.com/#organization"
      }
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://choive.com/#app",
      "name": "CHOIVE AI Selection Diagnostic",
      "url": "https://choive.com",
      "applicationCategory": "BusinessApplication",
      "operatingSystem": "Web",
      "description": "CHOIVE is the AI Selection Intelligence platform that measures, diagnoses, and closes the gap between where a business is and where AI recommends it — across ChatGPT, Perplexity, Gemini, and Claude.",
      "offers": [
        {
          "@type": "Offer",
          "name": "CHOIVE Diagnostic",
          "price": "0",
          "priceCurrency": "USD",
          "description": "Free AI selection diagnostic"
        },
        {
          "@type": "Offer",
          "name": "CHOIVE Analysis",
          "price": "99",
          "priceCurrency": "USD",
          "description": "Full AI selection diagnostic report"
        },
        {
          "@type": "Offer",
          "name": "CHOIVE Report",
          "price": "499",
          "priceCurrency": "USD",
          "description": "Complete ten-section AI Selection Report with founder letter, pillar evidence, AI simulation, competitor intelligence, prioritised actions, ready-to-use assets, and a 30-day implementation plan"
        }
      ],
      "publisher": {
        "@id": "https://choive.com/#organization"
      }
    },
    {
      "@type": "Service",
      "@id": "https://choive.com/#service",
      "name": "AI Selection Diagnostic",
      "serviceType": "AI Selection Diagnostic",
      "description": "CHOIVE measures, diagnoses, and closes the AI selection gap — for any business, in any category, anywhere in the world.",
      "provider": {
        "@id": "https://choive.com/#organization"
      },
      "areaServed": "Worldwide",
      "url": "https://choive.com"
    }
  ]
}
