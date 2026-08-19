'use strict';

// lib/business-archetype.js
// CHOIVE's single source of truth for "what KIND of business is this?".
//
// Different business types win customers in completely different ways. A local
// restaurant lives or dies on Google reviews and near-me search; a B2B software
// company is judged on clarity and proof; a charity is judged on its mission
// story. This module classifies the diagnosed subject into ONE archetype from
// the SAME evidence the diagnostic already collected, and describes what matters
// most for that type so the rest of the engine (fix plan, report, marketing kit)
// can prioritise and explain honestly.
//
// IMPORTANT: this does NOT change the 0-100 score or any pillar's maximum
// points. The score stays comparable across every business so it can be
// benchmarked against a category average. Business-type awareness changes what
// we PRIORITISE and how we EXPLAIN it — never the raw scale.

function t(value) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim(); }
function lower(value) { return t(value).toLowerCase(); }

// The nine archetypes (plus a safe fallback). These keys are shared with
// lib/marketing-content.js and MUST stay identical.
var ARCHETYPES = [
  'creator', 'nonprofit', 'real_estate', 'professional_practice',
  'b2b_software', 'industrial_b2b', 'local_consumer', 'ecommerce_dtc',
  'b2b_service', 'general_business'
];

// ── Classification ────────────────────────────────────────────────────────────
// Accepts either raw evidence (name/category/description/subjectType/
// marketReach/inferredCategory) or the marketing "facts" object (which also
// carries a `summary`). Order matters: the most specific subject types are
// decided first, then granular categories, then B2B vs B2C, then a fallback.
function classifyBusinessArchetype(input) {
  var facts = input && typeof input === 'object' ? input : {};
  var subjectType = lower(facts.subjectType) || 'business';
  var cat = lower(facts.category || facts.inferredCategory);
  var desc = lower(facts.description);
  var blob = cat + ' ' + desc + ' ' + lower(facts.summary);
  var reach = lower(facts.marketReach);

  if (subjectType === 'creator' || subjectType === 'personal_brand') return 'creator';
  if (subjectType === 'organization') return 'nonprofit';

  // Non-profits / associations / member bodies even when typed as "business"
  if (/non[ -]?profit|charity|charitable|ngo|foundation|trade association|member(?:ship)? (?:body|organi[sz]ation)|advocacy|community organi[sz]ation/.test(blob)) {
    return 'nonprofit';
  }
  // Real estate & property (commercial + residential + development + mortgage)
  if (/real[ -]?estate|estate agen|property (?:broker|agency|sales|management|development|developer)|realtor|residential brokerage|lettings|commercial real estate|mortgage broker/.test(blob)) {
    return 'real_estate';
  }
  // Regulated professional practices & personal financial/legal advisory
  if (/law firm|legal service|lawyer|attorney|solicitor|barrister|accountant|accounting firm|tax advis|tax preparation|architect|engineering firm|notary|medical practice|private (?:medical|dental) practice|dental practice|optician|physician|doctor|therapist|psycholog|chiropract|financial plann|financial advis|wealth manag|estate planning|insurance broker|debt counsel/.test(blob)) {
    return 'professional_practice';
  }
  // B2B software / SaaS / platform / IT
  if (/software|saas|platform|middleware|\bapi\b|\bsdk\b|developer tool|cloud (?:service|comput)|\bcrm\b|\berp\b|b2b tech|infrastructure|cyber ?security|data (?:platform|analytics)|business intelligence|artificial intelligence|\bai\b|machine learning|\bit services|managed service provider|\bmsp\b|payment (?:tech|platform|gateway)|fintech|mar(?:keting)? ?tech|hr ?tech|e-?learning platform|healthcare software|clinical (?:research|software)/.test(blob)) {
    return 'b2b_software';
  }
  // Industrial / manufacturing / wholesale / distribution / logistics
  if (/manufactur|industrial (?:equipment|automation|supply)|machinery|automotive supplier|aerospace|defen[cs]e|electronics manufactur|chemical manufactur|pharmaceutical manufactur|packaging|robotics|wholesale|distribution|distributor|import (?:and )?export|freight|logistics|warehous|supply chain|procurement|building supply|industrial distribution|medical (?:device|supply) (?:supplier|distribution)|equipment supplier|fertilizer|seed supplier|mining equipment|agricultural equipment/.test(blob)) {
    return 'industrial_b2b';
  }
  // Local consumer, foot-traffic / appointment / high-consideration local
  if (/restaurant|cafe|coffee shop|bakery|\bbar\b|\bpub\b|bistro|dining|takeaway|food truck|grocery|supermarket|salon|barber|spa|\bgym\b|fitness|yoga|pilates|studio|hotel|resort|hostel|guest house|vacation rental|tour operator|travel agency|dentist|dental|doctor|clinic|pharmacy|optician|veterinar|physiotherap|plumber|electrician|hvac|cleaning service|pest control|home security|landscap|gardening|appliance repair|auto repair|car dealership|car rental|driving school|tire shop|car detail|locksmith|florist|tattoo|nail|childcare|babysit|pet groom|pet boarding|dog walk|tutoring|language school|music lesson|moving company|storage service|laundry|tailoring/.test(blob)) {
    return 'local_consumer';
  }
  // Ecommerce / DTC brand / consumer product / subscription / streaming
  if (/e-?commerce|online (?:shop|store|marketplace|retailer)|d2c|dtc|direct[ -]to[ -]consumer|online butcher|delivery brand|meal[ -]?kit|subscription (?:box|service)|webshop|drop ?ship|marketplace seller|farm[ -]?(?:brand|direct)|streaming service|\bgaming\b|consumer (?:brand|product)/.test(blob)
      || (/store|shop|brand|beef|meat|coffee|wine|beverage|apparel|clothing|fashion|footwear|shoe|jewel|watch|cosmetic|skincare|fragrance|grooming|supplement|toy|furniture|home (?:goods|d[eé]cor)|electronics|pet food|luxury goods|sportswear/.test(blob)
          && /online|delivery|ship|versand|d2c|dtc|order|subscription|brand/.test(blob))) {
    return 'ecommerce_dtc';
  }
  // B2B service / agency / consultancy / staffing / BPO / commercial trades
  if (/consult|consultancy|agency|advertising|public relations|\bpr\b|branding|design agency|market research|\bb2b\b|managed service|systems integrat|staffing|recruit|executive search|business coaching|corporate training|translation service|business process outsourc|\bbpo\b|call cent|payroll|document management|corporate (?:travel|catering|communications|media)|commercial (?:construction|cleaning|insurance|real estate)|civil engineering|facilities management|building maintenance|security service|waste management|environmental consulting|clinical research organization|corporate wellness|occupational health|enterprise|for businesses|for operators?|trade customers?/.test(blob)
      || reach === 'global' || reach === 'international') {
    return 'b2b_service';
  }
  // Generic retail / physical store not otherwise matched → local consumer
  if (/retail|store|shop|boutique|dealership|market/.test(blob)) {
    return 'local_consumer';
  }
  return 'general_business';
}

// ── Archetype profiles ────────────────────────────────────────────────────────
// pillarEmphasis: how much each pillar matters for HOW this business type wins
// customers, on a 1 (nice to have) → 3 (mission-critical) scale. This is used to
// order the fix plan so the most important fixes for THIS type come first. It
// does NOT change the score.
// emphasisNote: one plain, simple sentence a five-year-old could follow, telling
// the owner what matters most for a business like theirs and why.
var ARCHETYPE_PROFILES = {
  local_consumer: {
    label: 'Local business',
    buyerNoun: 'customers nearby',
    pillarEmphasis: { clarity: 2, trust: 3, difference: 2, ease: 2 },
    emphasisNote: 'For a local business, being easy to find and having lots of good reviews matters most — people nearby pick who they trust.'
  },
  ecommerce_dtc: {
    label: 'Online shop / brand',
    buyerNoun: 'online shoppers',
    pillarEmphasis: { clarity: 2, trust: 3, difference: 2, ease: 3 },
    emphasisNote: 'For an online shop, shoppers must trust you and find buying quick and easy — reviews and a smooth checkout matter most.'
  },
  b2b_software: {
    label: 'Software company',
    buyerNoun: 'buying teams',
    pillarEmphasis: { clarity: 3, trust: 2, difference: 3, ease: 1 },
    emphasisNote: 'For a software company, buyers must instantly understand what you do and why you are different — clear words and proof matter most.'
  },
  b2b_service: {
    label: 'Business service / agency',
    buyerNoun: 'client companies',
    pillarEmphasis: { clarity: 2, trust: 2, difference: 3, ease: 1 },
    emphasisNote: 'For a business service, clients pick you for being clearly different and better — proof of your results matters most.'
  },
  professional_practice: {
    label: 'Professional practice',
    buyerNoun: 'clients and patients',
    pillarEmphasis: { clarity: 2, trust: 3, difference: 2, ease: 2 },
    emphasisNote: 'For a professional practice, people choose who they trust and can easily reach — reviews and clear, honest info matter most.'
  },
  real_estate: {
    label: 'Real estate',
    buyerNoun: 'buyers and sellers',
    pillarEmphasis: { clarity: 2, trust: 3, difference: 2, ease: 2 },
    emphasisNote: 'In real estate, people work with the agent they trust most — strong reviews and results matter most.'
  },
  creator: {
    label: 'Creator / influencer',
    buyerNoun: 'your audience',
    pillarEmphasis: { clarity: 2, trust: 2, difference: 3, ease: 2 },
    emphasisNote: 'For a creator, standing out with your own style is what wins fans — being different matters most.'
  },
  industrial_b2b: {
    label: 'Manufacturer / supplier',
    buyerNoun: 'buyers and engineers',
    pillarEmphasis: { clarity: 2, trust: 2, difference: 3, ease: 1 },
    emphasisNote: 'For a manufacturer, buyers want clear specs and proof you are reliable and better — being clearly different matters most.'
  },
  nonprofit: {
    label: 'Organisation / non-profit',
    buyerNoun: 'supporters',
    pillarEmphasis: { clarity: 2, trust: 3, difference: 3, ease: 2 },
    emphasisNote: 'For a non-profit, people give and join when they believe in your mission and trust you — a clear story and trust matter most.'
  },
  general_business: {
    label: 'Business',
    buyerNoun: 'customers',
    pillarEmphasis: { clarity: 2, trust: 2, difference: 2, ease: 2 },
    emphasisNote: 'To be picked, buyers must find you, understand you, trust you, and reach you easily — all four matter.'
  }
};

function getArchetypeProfile(archetype) {
  return ARCHETYPE_PROFILES[archetype] || ARCHETYPE_PROFILES.general_business;
}

module.exports = {
  ARCHETYPES: ARCHETYPES,
  classifyBusinessArchetype: classifyBusinessArchetype,
  ARCHETYPE_PROFILES: ARCHETYPE_PROFILES,
  getArchetypeProfile: getArchetypeProfile
};
