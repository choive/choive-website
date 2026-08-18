/**
 * Vertical-Specific Scoring Configuration
 * 
 * Defines how different verticals weight evidence types and platform signals.
 * Used to adjust CHOIVE Score calculations based on industry context.
 */

const VERTICAL_CONFIGS = {
  'b2b-saas': {
    name: 'B2B SaaS',
    weights: {
      reviews: 0.30,           // G2, Capterra, TrustRadius
      documentation: 0.25,      // Docs quality, API references
      caseStudies: 0.20,        // Customer success stories
      pricing: 0.15,            // Transparent pricing pages
      integrations: 0.10        // Integration marketplace presence
    },
    platformPreferences: {
      claude: ['documentation', 'caseStudies'],
      chatgpt: ['reviews', 'caseStudies'],
      perplexity: ['reviews', 'integrations'],
      gemini: ['documentation', 'pricing']
    },
    benchmarkAverage: 64,
    topQuartile: 81
  },
  
  'ecommerce-dtc': {
    name: 'E-commerce (DTC)',
    weights: {
      productReviews: 0.35,     // Product review density & sentiment
      socialProof: 0.20,        // Instagram, UGC, testimonials
      returnPolicy: 0.15,       // Clear return/refund policies
      productPages: 0.15,       // Product description quality
      shipping: 0.15            // Shipping transparency
    },
    platformPreferences: {
      claude: ['productPages', 'returnPolicy'],
      chatgpt: ['productReviews', 'socialProof'],
      perplexity: ['productReviews', 'shipping'],
      gemini: ['socialProof', 'productPages']
    },
    benchmarkAverage: 61,
    topQuartile: 78
  },
  
  'professional-services': {
    name: 'Professional Services',
    weights: {
      credentials: 0.25,        // Certifications, licenses
      caseStudies: 0.25,        // Client work examples
      teamBios: 0.20,           // Team expertise, backgrounds
      testimonials: 0.20,       // Client testimonials
      thought: 0.10             // Published articles, speaking
    },
    platformPreferences: {
      claude: ['credentials', 'caseStudies'],
      chatgpt: ['testimonials', 'caseStudies'],
      perplexity: ['credentials', 'thought'],
      gemini: ['credentials', 'teamBios']
    },
    benchmarkAverage: 52,
    topQuartile: 71
  },
  
  'b2b-agency': {
    name: 'B2B Agency',
    weights: {
      portfolio: 0.30,          // Public work samples
      caseStudies: 0.25,        // Results-focused case studies
      process: 0.20,            // Methodology transparency
      teamBios: 0.15,           // Team backgrounds
      testimonials: 0.10        // Client testimonials
    },
    platformPreferences: {
      claude: ['process', 'caseStudies'],
      chatgpt: ['portfolio', 'caseStudies'],
      perplexity: ['portfolio', 'testimonials'],
      gemini: ['teamBios', 'process']
    },
    benchmarkAverage: 49,
    topQuartile: 68
  },
  
  'developer-tools': {
    name: 'Developer Tools',
    weights: {
      github: 0.30,             // GitHub activity, stars, commits
      documentation: 0.30,      // Docs quality, examples
      community: 0.20,          // Stack Overflow, Discord, forums
      integrations: 0.10,       // Ecosystem integrations
      opensource: 0.10          // Open source contributions
    },
    platformPreferences: {
      claude: ['documentation', 'github'],
      chatgpt: ['github', 'community'],
      perplexity: ['github', 'integrations'],
      gemini: ['documentation', 'community']
    },
    benchmarkAverage: 71,
    topQuartile: 87
  },
  
  'healthcare-tech': {
    name: 'Healthcare Tech',
    weights: {
      compliance: 0.30,         // HIPAA, SOC 2, certifications
      security: 0.25,           // Security documentation
      caseStudies: 0.20,        // Healthcare client examples
      integrations: 0.15,       // EHR integrations
      testimonials: 0.10        // Client testimonials
    },
    platformPreferences: {
      claude: ['compliance', 'security'],
      chatgpt: ['caseStudies', 'testimonials'],
      perplexity: ['compliance', 'integrations'],
      gemini: ['compliance', 'caseStudies']
    },
    benchmarkAverage: 57,
    topQuartile: 76
  },
  
  'fintech': {
    name: 'Fintech',
    weights: {
      regulatory: 0.30,         // Regulatory compliance, licenses
      security: 0.25,           // Security certifications, audits
      transparency: 0.20,       // Fee transparency, terms clarity
      reviews: 0.15,            // User reviews
      integrations: 0.10        // Banking/financial integrations
    },
    platformPreferences: {
      claude: ['regulatory', 'transparency'],
      chatgpt: ['reviews', 'security'],
      perplexity: ['regulatory', 'integrations'],
      gemini: ['security', 'transparency']
    },
    benchmarkAverage: 63,
    topQuartile: 80
  },
  
  'local-services': {
    name: 'Local Services',
    weights: {
      googleReviews: 0.40,      // Google review count & sentiment
      responsiveness: 0.20,     // Response time to inquiries
      photos: 0.15,             // Visual proof of work
      pricing: 0.15,            // Pricing transparency
      hours: 0.10               // Business hours, availability
    },
    platformPreferences: {
      claude: ['googleReviews', 'pricing'],
      chatgpt: ['googleReviews', 'photos'],
      perplexity: ['googleReviews', 'responsiveness'],
      gemini: ['googleReviews', 'hours']
    },
    benchmarkAverage: 46,
    topQuartile: 64
  },
  
  'education-courses': {
    name: 'Education/Courses',
    weights: {
      outcomes: 0.30,           // Student outcomes, job placement
      curriculum: 0.25,         // Curriculum transparency
      instructors: 0.20,        // Instructor credentials
      reviews: 0.15,            // Student reviews
      samples: 0.10             // Free samples, previews
    },
    platformPreferences: {
      claude: ['curriculum', 'outcomes'],
      chatgpt: ['reviews', 'outcomes'],
      perplexity: ['outcomes', 'instructors'],
      gemini: ['instructors', 'curriculum']
    },
    benchmarkAverage: 54,
    topQuartile: 73
  },
  
  'enterprise-software': {
    name: 'Enterprise Software',
    weights: {
      caseStudies: 0.30,        // Enterprise customer stories
      security: 0.25,           // Security certifications
      integrations: 0.20,       // Enterprise integrations
      analyst: 0.15,            // Analyst reports (Gartner, Forrester)
      documentation: 0.10       // Implementation docs
    },
    platformPreferences: {
      claude: ['caseStudies', 'documentation'],
      chatgpt: ['caseStudies', 'analyst'],
      perplexity: ['analyst', 'integrations'],
      gemini: ['security', 'caseStudies']
    },
    benchmarkAverage: 66,
    topQuartile: 83
  }
};

/**
 * Get configuration for a specific vertical
 */
function getVerticalConfig(verticalId) {
  return VERTICAL_CONFIGS[verticalId] || null;
}

/**
 * List all available verticals
 */
function listVerticals() {
  return Object.keys(VERTICAL_CONFIGS).map(id => ({
    id,
    name: VERTICAL_CONFIGS[id].name,
    benchmarkAverage: VERTICAL_CONFIGS[id].benchmarkAverage,
    topQuartile: VERTICAL_CONFIGS[id].topQuartile
  }));
}

/**
 * Apply vertical-specific adjustments to a raw score
 * 
 * @param {number} rawScore - The base CHOIVE Score (0-100)
 * @param {string} verticalId - The vertical identifier
 * @param {object} evidenceProfile - The business's evidence breakdown
 * @returns {object} { adjustedScore, adjustments }
 */
function applyVerticalAdjustments(rawScore, verticalId, evidenceProfile) {
  const config = getVerticalConfig(verticalId);
  
  if (!config) {
    return {
      adjustedScore: rawScore,
      adjustments: [],
      verticalNotFound: true
    };
  }
  
  const adjustments = [];
  let totalAdjustment = 0;
  
  // Check each evidence type against vertical weights
  for (const [evidenceType, weight] of Object.entries(config.weights)) {
    const evidenceStrength = evidenceProfile[evidenceType] || 0; // 0-100
    const expectedContribution = weight * 100;
    const actualContribution = (evidenceStrength / 100) * weight * 100;
    const gap = actualContribution - expectedContribution;
    
    // Adjust score based on gap (capped at ±2 per evidence type)
    const adjustment = Math.max(-2, Math.min(2, gap / 10));
    totalAdjustment += adjustment;
    
    if (Math.abs(adjustment) > 0.5) {
      adjustments.push({
        evidenceType,
        weight,
        strength: evidenceStrength,
        adjustment: Math.round(adjustment * 10) / 10,
        message: adjustment > 0 
          ? `Strong ${evidenceType} evidence (${evidenceStrength}/100) exceeds vertical expectations`
          : `Weak ${evidenceType} evidence (${evidenceStrength}/100) below vertical expectations`
      });
    }
  }
  
  // Cap total adjustment at ±8 points
  totalAdjustment = Math.max(-8, Math.min(8, totalAdjustment));
  
  const adjustedScore = Math.max(0, Math.min(100, Math.round(rawScore + totalAdjustment)));
  
  return {
    adjustedScore,
    rawScore,
    totalAdjustment: Math.round(totalAdjustment * 10) / 10,
    adjustments,
    vertical: config.name,
    benchmarkAverage: config.benchmarkAverage,
    topQuartile: config.topQuartile
  };
}

module.exports = {
  VERTICAL_CONFIGS,
  getVerticalConfig,
  listVerticals,
  applyVerticalAdjustments
};
