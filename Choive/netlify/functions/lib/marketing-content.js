'use strict';

// lib/marketing-content.js
// CHOIVE archetype-aware marketing kit generator.
//
// Every business type markets differently. A restaurant lives on Instagram
// Reels and Google local intent; a B2B SaaS company lives on LinkedIn, blog
// SEO and case studies; a content creator lives on YouTube and collaborations.
// This module classifies the diagnosed subject into a marketing archetype from
// the SAME evidence the diagnostic already collected, then produces marketing
// assets whose channels, formats, cadence and copy match that archetype.
//
// Hard rule, identical to the rest of CHOIVE: every claim is built only from
// verified facts passed in (offers, audiences, differentiator, reviews, place).
// Nothing is invented. Where a fact is missing, the asset simply omits it.

// ── Small text helpers (self-contained; no cross-module coupling) ─────────────
function t(value) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim(); }
function cap(value) { var s = t(value); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
function lower(value) { return t(value).toLowerCase(); }
function trimPeriod(value) { return t(value).replace(/[.\s]+$/, ''); }
function titleCase(value) {
  return t(value).split(' ').map(function(w) { return w ? w.charAt(0).toUpperCase() + w.slice(1) : w; }).join(' ');
}
function clampChars(value, max) {
  var s = t(value);
  if (s.length <= max) return s;
  var cut = s.slice(0, max);
  var sp = cut.lastIndexOf(' ');
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-]+$/, '');
}
function firstList(arr, n) {
  return (Array.isArray(arr) ? arr : []).map(t).filter(Boolean).slice(0, n || 5);
}

// ── Archetype classification ──────────────────────────────────────────────────
// Reads the evidence signals the diagnostic already established and maps the
// subject to exactly one marketing archetype. Order matters: the most specific
// subject types (creator, organization) are decided first, then the granular
// business categories, then B2B vs B2C, with a safe general fallback.
function classifyMarketingArchetype(facts) {
  var subjectType = lower(facts.subjectType) || 'business';
  var cat = lower(facts.category);
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
  // Regulated professional practices & personal financial/legal advisory (trust + local, appointment-based)
  if (/law firm|legal service|lawyer|attorney|solicitor|barrister|accountant|accounting firm|tax advis|tax preparation|architect|engineering firm|notary|medical practice|private (?:medical|dental) practice|dental practice|optician|physician|doctor|therapist|psycholog|chiropract|financial plann|financial advis|wealth manag|estate planning|insurance broker|debt counsel/.test(blob)) {
    return 'professional_practice';
  }
  // B2B software / SaaS / platform / IT (incl. healthcare software, e-learning platforms, fintech/martech/HR tech)
  if (/software|saas|platform|middleware|\bapi\b|\bsdk\b|developer tool|cloud (?:service|comput)|\bcrm\b|\berp\b|b2b tech|infrastructure|cyber ?security|data (?:platform|analytics)|business intelligence|artificial intelligence|\bai\b|machine learning|\bit services|managed service provider|\bmsp\b|payment (?:tech|platform|gateway)|fintech|mar(?:keting)? ?tech|hr ?tech|e-?learning platform|healthcare software|clinical (?:research|software)/.test(blob)) {
    return 'b2b_software';
  }
  // Industrial / manufacturing / wholesale / distribution / logistics (trade-show + distributor + spec-driven)
  if (/manufactur|industrial (?:equipment|automation|supply)|machinery|automotive supplier|aerospace|defen[cs]e|electronics manufactur|chemical manufactur|pharmaceutical manufactur|packaging|robotics|wholesale|distribution|distributor|import (?:and )?export|freight|logistics|warehous|supply chain|procurement|building supply|industrial distribution|medical (?:device|supply) (?:supplier|distribution)|equipment supplier|fertilizer|seed supplier|mining equipment|agricultural equipment/.test(blob)) {
    return 'industrial_b2b';
  }
  // Local consumer, foot-traffic / appointment / high-consideration local (incl. auto dealers, travel/hospitality, local schools, pharmacies)
  if (/restaurant|cafe|coffee shop|bakery|\bbar\b|\bpub\b|bistro|dining|takeaway|food truck|grocery|supermarket|salon|barber|spa|\bgym\b|fitness|yoga|pilates|studio|hotel|resort|hostel|guest house|vacation rental|tour operator|travel agency|dentist|dental|doctor|clinic|pharmacy|optician|veterinar|physiotherap|plumber|electrician|hvac|cleaning service|pest control|home security|landscap|gardening|appliance repair|auto repair|car dealership|car rental|driving school|tire shop|car detail|locksmith|florist|tattoo|nail|childcare|babysit|pet groom|pet boarding|dog walk|tutoring|language school|music lesson|moving company|storage service|laundry|tailoring/.test(blob)) {
    return 'local_consumer';
  }
  // Ecommerce / DTC brand / consumer product / subscription / streaming
  if (/e-?commerce|online (?:shop|store|marketplace|retailer)|d2c|dtc|direct[ -]to[ -]consumer|online butcher|delivery brand|meal[ -]?kit|subscription (?:box|service)|webshop|drop ?ship|marketplace seller|farm[ -]?(?:brand|direct)|streaming service|\bgaming\b|consumer (?:brand|product)/.test(blob)
      || (/store|shop|brand|beef|meat|coffee|wine|beverage|apparel|clothing|fashion|footwear|shoe|jewel|watch|cosmetic|skincare|fragrance|grooming|supplement|toy|furniture|home (?:goods|d[eé]cor)|electronics|pet food|luxury goods|sportswear/.test(blob)
          && /online|delivery|ship|versand|d2c|dtc|order|subscription|brand/.test(blob))) {
    return 'ecommerce_dtc';
  }
  // B2B service / agency / consultancy / staffing / BPO / commercial trades / corporate services
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

// ── Archetype playbooks ─────────────────────────────────────────────────────
// Each playbook encodes HOW that archetype should market: the label buyers use,
// which channels win, the ad platforms worth money, the content formats that
// perform, and the posting cadence. This is the strategic intelligence that
// makes the output type-specific rather than generic.
var PLAYBOOKS = {
  local_consumer: {
    label: 'Local consumer business',
    buyerNoun: 'customers nearby',
    primaryChannels: ['Google Business Profile', 'Instagram', 'Facebook', 'Local SEO'],
    adPlatforms: ['google_search', 'google_local', 'meta'],
    contentFormats: ['Instagram Reels', 'Google Business posts', 'customer photos', 'behind-the-scenes stories'],
    cadence: '4–5 short posts/week + weekly Google Business update',
    strategy: 'People decide locally and visually. Win Google Maps and near-me search, then keep an active Instagram/Facebook presence with real photos, offers and reviews. Speed of reply and fresh reviews beat clever copy.',
    channelPriority: [
      ['Google Business Profile', 'Most near-me buyers decide here. Keep hours, photos, and posts fresh; reply to every review within 24h.'],
      ['Instagram / Facebook', 'Visual proof of the experience. Reels of the space, product and happy customers convert locally.'],
      ['Local SEO pages', 'A page per service and per area you serve captures "[service] near me" searches.'],
      ['Email / SMS list', 'Repeat visits are the profit. Collect contacts at point of sale and send offers monthly.']
    ]
  },
  ecommerce_dtc: {
    label: 'Ecommerce / direct-to-consumer brand',
    buyerNoun: 'online shoppers',
    primaryChannels: ['Instagram', 'TikTok', 'Email/SMS', 'Google Shopping', 'Meta Ads'],
    adPlatforms: ['meta', 'google_shopping', 'tiktok'],
    contentFormats: ['product Reels/TikToks', 'unboxing', 'user-generated content', 'email flows'],
    cadence: 'Daily short-form video + 2–3 emails/week across flows',
    strategy: 'Growth is paid social + retention email. Lead with the product in motion and proof (reviews, results), retarget browsers, and monetise the list with automated flows (welcome, abandoned cart, post-purchase).',
    channelPriority: [
      ['Meta & TikTok ads', 'Primary acquisition. Test 3–5 creative angles weekly; scale the winners.'],
      ['Email & SMS flows', 'Highest ROI. Welcome, abandoned-cart and post-purchase flows run 24/7.'],
      ['Organic short-form video', 'Reels/TikToks of the product in use build cheap reach and feed the ad account.'],
      ['Google Shopping / SEO', 'Captures high-intent buyers already searching the product category.']
    ]
  },
  b2b_software: {
    label: 'B2B software / SaaS',
    buyerNoun: 'buying teams and decision-makers',
    primaryChannels: ['LinkedIn', 'SEO blog', 'Case studies', 'Comparison pages', 'Webinars'],
    adPlatforms: ['linkedin', 'google_search'],
    contentFormats: ['thought-leadership posts', 'SEO articles', 'case studies', 'product comparison pages', 'demo videos'],
    cadence: '3–4 LinkedIn posts/week + 2 SEO articles/month + 1 case study/month',
    strategy: 'Long, multi-stakeholder cycles are won with authority and proof. Rank for problem/solution and "[category] software" searches, publish case studies with hard numbers, and build a founder/expert voice on LinkedIn. Comparison and alternatives pages capture buyers in evaluation.',
    channelPriority: [
      ['SEO blog & comparison pages', 'Buyers research before they talk to sales. Rank for the problem, the category, and "[competitor] alternative".'],
      ['LinkedIn (founder + company)', 'Where B2B decision-makers spend attention. Expertise + customer results build the pipeline.'],
      ['Case studies', 'Named results with numbers are the single most persuasive B2B asset.'],
      ['Email nurture / webinars', 'Long cycles need staying power. Educate leads until they are ready to buy.']
    ]
  },
  b2b_service: {
    label: 'B2B service / agency / consultancy',
    buyerNoun: 'client organisations',
    primaryChannels: ['LinkedIn', 'Case studies', 'Referrals', 'SEO blog', 'Email'],
    adPlatforms: ['linkedin', 'google_search'],
    contentFormats: ['expert LinkedIn posts', 'client case studies', 'how-we-work guides', 'newsletters'],
    cadence: '3 LinkedIn posts/week + 1 case study/month + monthly newsletter',
    strategy: 'Trust and proof close deals. Lead with named client results, a clear method, and consistent expert content on LinkedIn. Referrals and a warm newsletter are the highest-ROI channels; ads mainly support search intent.',
    channelPriority: [
      ['LinkedIn', 'Your buyers and referrers are here. Expertise + client wins generate inbound.'],
      ['Case studies & proof', 'Named outcomes are what turns interest into a call.'],
      ['Referral & partner network', 'The cheapest, highest-close-rate channel for services — ask deliberately.'],
      ['SEO & newsletter', 'Rank for the service + city/industry; keep past leads warm with a monthly send.']
    ]
  },
  professional_practice: {
    label: 'Professional practice',
    buyerNoun: 'prospective clients and patients',
    primaryChannels: ['Google Business Profile', 'Reviews', 'Local SEO', 'Referrals', 'Educational content'],
    adPlatforms: ['google_search', 'google_local'],
    contentFormats: ['plain-language explainer articles', 'FAQ pages', 'Google posts', 'trust/credential content'],
    cadence: '2 explainer posts/month + ongoing review generation',
    strategy: 'Clients choose on trust and proximity. Win local search and Google reviews, publish plain-language answers to the questions clients actually ask, and make credentials and outcomes easy to verify. Avoid hype — clarity and authority convert.',
    channelPriority: [
      ['Google Business Profile & reviews', 'Most clients start with a local search and read reviews before calling.'],
      ['Educational content / FAQ', 'Answering real questions in plain language builds trust and ranks in search.'],
      ['Referrals', 'Word of mouth is the top channel — make it easy for happy clients to refer.'],
      ['Search ads (intent)', 'Capture high-intent "[service] in [city]" searches when demand is immediate.']
    ]
  },
  real_estate: {
    label: 'Real estate',
    buyerNoun: 'buyers, sellers and investors',
    primaryChannels: ['Instagram', 'YouTube/video tours', 'Portals', 'Google Business Profile', 'Email'],
    adPlatforms: ['meta', 'google_search'],
    contentFormats: ['property video tours', 'neighbourhood guides', 'market updates', 'client testimonials'],
    cadence: 'Video tour per new listing + 3 social posts/week + monthly market update',
    strategy: 'Listings are visual and local. Lead with high-quality property video and neighbourhood content, dominate Instagram and portals, and stay top-of-mind with a market-update email. Testimonials and sold results are your proof.',
    channelPriority: [
      ['Instagram & video tours', 'Property is sold on video and photos. Reels of listings and areas drive enquiries.'],
      ['Listing portals & local SEO', 'Where active buyers search. Complete, well-shot listings win the click.'],
      ['Email market updates', 'Sellers and investors act on timing — a monthly update keeps you their agent.'],
      ['Meta ads (listing + area)', 'Cheap, precise geo-targeting to buyers in and moving to the area.']
    ]
  },
  creator: {
    label: 'Content creator / influencer',
    buyerNoun: 'your audience',
    primaryChannels: ['YouTube', 'Instagram', 'TikTok', 'Email newsletter', 'Collaborations'],
    adPlatforms: ['meta', 'youtube'],
    contentFormats: ['flagship long-form video', 'short clips', 'collaborations', 'newsletter'],
    cadence: '1 flagship piece/week + daily short clips repurposed from it',
    strategy: 'Reach compounds through consistency and collaboration. Publish one flagship piece a week, cut it into daily shorts across platforms, collaborate with adjacent creators to borrow audiences, and own the relationship with an email newsletter you control.',
    channelPriority: [
      ['Flagship platform (YouTube/primary)', 'One deep piece a week anchors your authority and library.'],
      ['Short-form clips', 'Repurpose the flagship into daily Reels/Shorts/TikToks for reach.'],
      ['Collaborations', 'The fastest way to grow — borrow adjacent creators\u2019 audiences.'],
      ['Email newsletter', 'The only audience you own. Move fans off rented platforms.']
    ]
  },
  industrial_b2b: {
    label: 'Industrial / manufacturing / distribution',
    buyerNoun: 'procurement teams, engineers and distributors',
    primaryChannels: ['LinkedIn', 'Trade publications & shows', 'SEO spec pages', 'Distributor/partner network', 'Email'],
    adPlatforms: ['linkedin', 'google_search'],
    contentFormats: ['spec sheets & datasheets', 'application case studies', 'how-it-works explainers', 'trade-show content', 'technical LinkedIn posts'],
    cadence: '2–3 LinkedIn posts/week + 1 technical case study/month + trade-show bursts',
    strategy: 'Buyers are technical and cautious, cycles are long, and orders are large. Win with detailed spec/application pages that rank for exact part and capability searches, proof of quality and reliability (certifications, tolerances, named clients), and a strong distributor/partner and trade-show presence. LinkedIn builds credibility with engineers and buyers.',
    channelPriority: [
      ['Technical SEO (spec & application pages)', 'Engineers search exact capabilities and part specs — rank for them with detailed pages.'],
      ['Distributor & partner network', 'Reps and distributors move industrial volume — arm them with materials and referrals.'],
      ['Trade publications & shows', 'Still where serious industrial buyers discover and vet suppliers.'],
      ['LinkedIn + case studies', 'Named application results and certifications build trust with technical buyers.']
    ]
  },
  nonprofit: {
    label: 'Organisation / non-profit',
    buyerNoun: 'supporters, members and beneficiaries',
    primaryChannels: ['Email', 'Instagram/Facebook', 'Website/blog', 'Events', 'Google Ad Grants'],
    adPlatforms: ['google_grants', 'meta'],
    contentFormats: ['impact stories', 'beneficiary spotlights', 'campaign updates', 'donor emails'],
    cadence: '3 social posts/week + monthly supporter email + campaign bursts',
    strategy: 'Mission and impact drive action. Tell concrete impact stories, make it effortless to donate or join, and steward supporters with a warm monthly email. Google Ad Grants can fund free search traffic for eligible non-profits.',
    channelPriority: [
      ['Email to supporters', 'The backbone of donations and retention — tell impact, then ask clearly.'],
      ['Social storytelling', 'Beneficiary and volunteer stories spread mission and recruit supporters.'],
      ['Website impact content', 'Show verifiable outcomes so donors and partners can trust the work.'],
      ['Google Ad Grants', 'Eligible non-profits get free search ads — capture mission-relevant searches.']
    ]
  },
  general_business: {
    label: 'Business',
    buyerNoun: 'prospective customers',
    primaryChannels: ['Google Business Profile', 'Website/SEO', 'Social media', 'Email', 'Reviews'],
    adPlatforms: ['google_search', 'meta'],
    contentFormats: ['helpful articles', 'social posts', 'customer stories', 'offers'],
    cadence: '3 posts/week + monthly email + ongoing reviews',
    strategy: 'Be found where buyers search, prove you deliver with reviews and customer stories, and keep past customers close with email. Match spend to intent: search ads for people ready to buy, social for awareness.',
    channelPriority: [
      ['Search presence (Google + SEO)', 'Capture buyers actively looking for what you sell.'],
      ['Reviews & customer proof', 'Social proof is the deciding factor for most first-time buyers.'],
      ['Social media', 'Stay visible and show the business is active and trusted.'],
      ['Email list', 'Turn one-time buyers into repeat customers cheaply.']
    ]
  }
};

function playbook(archetype) { return PLAYBOOKS[archetype] || PLAYBOOKS.general_business; }

// ── Fact normalisation ────────────────────────────────────────────────────────
// Pulls the verified facts CHOIVE already produced into one predictable object.
// Nothing here invents content; missing fields stay empty and downstream
// generators simply skip the assets they cannot support.
function normalizeFacts(rawFacts) {
  var f = rawFacts && typeof rawFacts === 'object' ? rawFacts : {};
  var offers = firstList(f.offers, 5);
  var audiences = firstList(f.audiences, 4);
  var distinctions = firstList(f.distinctions, 3);
  var place = t(f.place);
  var isLocalPlace = place && !/worldwide|international|global|national/i.test(place);
  return {
    name: t(f.name),
    category: t(f.category),
    categoryLower: lower(f.category),
    differentiator: trimPeriod(f.differentiator),
    summary: t(f.summary),
    description: t(f.description),
    subjectType: lower(f.subjectType) || 'business',
    marketReach: lower(f.marketReach),
    place: place,
    isLocalPlace: isLocalPlace,
    siteUrl: t(f.siteUrl),
    offers: offers,
    primaryOffer: offers[0] || t(f.category),
    audiences: audiences,
    primaryAudience: audiences[0] || '',
    distinctions: distinctions,
    googleRating: t(f.googleRating),
    googleReviewCount: t(f.googleReviewCount),
    hasReviews: !!(t(f.googleRating) || t(f.trustpilotRating))
  };
}

// ── 1. Ad copy pack ───────────────────────────────────────────────────────────
// Produces channel-appropriate ad copy for exactly the platforms that matter to
// the archetype. Google/LinkedIn headlines respect real character limits so the
// owner can paste them straight into the ad manager.
function generateAdCopy(f, pb) {
  if (!f.name) return null;
  var groups = [];
  var offer = f.primaryOffer || f.category;
  var placeTail = f.isLocalPlace ? ' in ' + f.place : '';
  var diff = f.differentiator;
  var aud = f.primaryAudience;

  function googleSearchAds() {
    var headlines = [];
    if (offer) headlines.push(clampChars(titleCase(f.name), 30));
    if (offer) headlines.push(clampChars(cap(offer) + placeTail, 30));
    if (diff) headlines.push(clampChars(cap(diff), 30));
    if (aud) headlines.push(clampChars('Built For ' + cap(aud), 30));
    headlines.push(clampChars((f.isLocalPlace ? 'Trusted ' + (f.place) + ' Choice' : 'Get Started Today'), 30));
    var descs = [];
    var d1 = (offer ? cap(offer) : cap(f.category)) + (placeTail ? placeTail : '') + (diff ? '. ' + cap(diff) : '') + '.';
    descs.push(clampChars(d1, 90));
    var d2 = (f.hasReviews ? 'Rated ' + f.googleRating + '★ by real customers. ' : '') + 'See why buyers choose ' + f.name + '.';
    descs.push(clampChars(d2, 90));
    return { platform: 'Google Search Ads', note: 'Headlines ≤30 chars, descriptions ≤90 chars — paste into Google Ads.', headlines: headlines.filter(Boolean).slice(0, 5), descriptions: descs.filter(Boolean).slice(0, 2) };
  }

  function metaAds() {
    var primaryTexts = [];
    var p1 = (aud ? cap(aud) + ': ' : '') + (offer ? cap(offer) : cap(f.category)) + (placeTail ? placeTail : '') + '.' + (diff ? ' ' + cap(diff) + '.' : '');
    primaryTexts.push(clampChars(p1, 200));
    var p2 = (diff ? cap(diff) + '. ' : '') + 'Discover ' + f.name + (placeTail ? placeTail : '') + '.' + (f.hasReviews ? ' ' + f.googleRating + '★ from real customers.' : '');
    primaryTexts.push(clampChars(p2, 200));
    var headline = clampChars((offer ? cap(offer) : cap(f.name)) + (placeTail ? placeTail : ''), 40);
    return { platform: 'Facebook / Instagram Ads', note: 'Primary text ≤125 chars shows before "See more"; keep the hook first. Pair with a real product/space photo or short video.', primaryText: primaryTexts.filter(Boolean), headline: headline, cta: 'Learn More' };
  }

  function linkedinAds() {
    var intro = [];
    var i1 = (aud ? cap(aud) + ' — ' : '') + (offer ? cap(offer) : cap(f.category)) + '.' + (diff ? ' ' + cap(diff) + '.' : '');
    intro.push(clampChars(i1, 150));
    var i2 = 'See how ' + f.name + ' helps ' + (aud || 'teams') + '.' + (diff ? ' ' + cap(diff) + '.' : '');
    intro.push(clampChars(i2, 150));
    return { platform: 'LinkedIn Sponsored Content', note: 'Lead with the buyer and the outcome; LinkedIn buyers scan for relevance. Pair with a case study or demo link.', introText: intro.filter(Boolean), headline: clampChars((offer ? cap(offer) : cap(f.name)), 70), cta: 'Learn More' };
  }

  function googleShopping() {
    var title = clampChars(titleCase(f.name) + (offer ? ' — ' + cap(offer) : ''), 150);
    var desc = clampChars((offer ? cap(offer) : cap(f.category)) + (diff ? '. ' + cap(diff) : '') + (f.hasReviews ? '. Rated ' + f.googleRating + '★.' : '') + '.', 400);
    return { platform: 'Google Shopping (product feed)', note: 'Front-load the product title with the terms buyers search; keep attributes accurate.', title: title, description: desc };
  }

  var wants = pb.adPlatforms || ['google_search', 'meta'];
  if (wants.indexOf('google_search') !== -1 || wants.indexOf('google_local') !== -1 || wants.indexOf('google_grants') !== -1) groups.push(googleSearchAds());
  if (wants.indexOf('meta') !== -1 || wants.indexOf('tiktok') !== -1 || wants.indexOf('youtube') !== -1) groups.push(metaAds());
  if (wants.indexOf('linkedin') !== -1) groups.push(linkedinAds());
  if (wants.indexOf('google_shopping') !== -1) groups.push(googleShopping());
  if (!groups.length) { groups.push(googleSearchAds()); groups.push(metaAds()); }
  return { archetypeLabel: pb.label, intro: 'Ad copy written for the channels that actually convert for a ' + pb.label.toLowerCase() + '. Every line is built from your verified facts — edit tone before spending.', groups: groups };
}

// ── 2. 30-day content calendar ────────────────────────────────────────────────
// A four-week plan whose post themes, channels and formats match the archetype.
// Themes cycle through the marketing job-to-be-done (attract, prove, educate,
// convert, retain) and pull in the business's real offers and differentiator.
function generateContentCalendar(f, pb) {
  if (!f.name) return null;
  var formats = pb.contentFormats || ['social post', 'article', 'customer story'];
  var fmt = function(i) { return formats[i % formats.length]; };
  var offer = f.primaryOffer || f.category;
  var diff = f.differentiator;
  var aud = f.primaryAudience;
  var offersCycle = f.offers.length ? f.offers : [offer];

  var themes = [
    { week: 1, focus: 'Attract — get discovered', posts: [
        { day: 'Mon', format: fmt(0), idea: 'Introduce ' + f.name + ': what you do' + (aud ? ' for ' + aud : '') + (f.isLocalPlace ? ' in ' + f.place : '') + '.' },
        { day: 'Wed', format: fmt(1), idea: 'Answer the #1 question buyers ask before choosing ' + (offer ? offer : 'you') + '.' },
        { day: 'Fri', format: fmt(2), idea: (diff ? 'Show what makes you different: ' + diff + '.' : 'Show a real behind-the-scenes look at how you work.') }
      ] },
    { week: 2, focus: 'Prove — build trust', posts: [
        { day: 'Mon', format: fmt(2), idea: (f.hasReviews ? 'Feature a real ' + f.googleRating + '★ review and the story behind it.' : 'Share a real customer result or before/after.') },
        { day: 'Wed', format: fmt(0), idea: 'Spotlight ' + (offersCycle[1 % offersCycle.length] || offer) + ' — who it is for and why it works.' },
        { day: 'Fri', format: fmt(1), idea: 'Explain your process step by step so buyers know what to expect.' }
      ] },
    { week: 3, focus: 'Educate — become the expert', posts: [
        { day: 'Mon', format: fmt(1), idea: 'Teach one thing your ' + (aud || 'buyers') + ' get wrong about ' + (f.category || 'this') + '.' },
        { day: 'Wed', format: fmt(0), idea: 'Myth vs fact in ' + (f.category || 'your field') + ' — set the record straight.' },
        { day: 'Fri', format: fmt(2), idea: 'Case story: how you solved a real problem for a ' + (aud || 'customer') + '.' }
      ] },
    { week: 4, focus: 'Convert & retain', posts: [
        { day: 'Mon', format: fmt(0), idea: 'Make a clear offer for ' + (offer || 'your service') + (f.isLocalPlace ? ' in ' + f.place : '') + ' with one call to action.' },
        { day: 'Wed', format: fmt(2), idea: 'Answer the top objection that stops people buying — honestly.' },
        { day: 'Fri', format: fmt(1), idea: 'Recap the month + invite past customers back with a reason to return.' }
      ] }
  ];
  return { archetypeLabel: pb.label, cadence: pb.cadence, channels: pb.primaryChannels, intro: 'A 30-day plan built for a ' + pb.label.toLowerCase() + '. Channels and formats are chosen for how your buyers actually discover and decide. Swap in your own photos and voice.', weeks: themes };
}

// ── 3. Email marketing sequence ───────────────────────────────────────────────
// A short, archetype-tuned sequence with subject lines and body outlines. B2B
// leans nurture/proof; ecommerce leans flows; local leans offer + reviews.
function generateEmailSequence(f, pb, archetype) {
  if (!f.name) return null;
  var offer = f.primaryOffer || f.category;
  var diff = f.differentiator;
  var aud = f.primaryAudience;
  var emails = [];

  function push(purpose, subject, body) { emails.push({ purpose: purpose, subject: clampChars(subject, 65), body: body }); }

  // Welcome email — universal, always grounded
  push('Welcome (send immediately)',
    'Welcome to ' + f.name,
    'Thank them for joining. In 2–3 short lines say what ' + f.name + ' does'
      + (aud ? ' for ' + aud : '') + (diff ? ', and why it is different: ' + diff : '')
      + '. End with one clear next step (' + (f.siteUrl ? 'visit ' + f.siteUrl : 'reply or book') + ').');

  if (archetype === 'ecommerce_dtc') {
    push('Abandoned cart (send ~1h after)', 'You left something behind', 'Remind them of the item, restate one real benefit' + (diff ? ' (' + diff + ')' : '') + ', add a review or guarantee, and link back to checkout.');
    push('Post-purchase (send after delivery)', 'How to get the most from your order', 'Thank them, give 2–3 quick tips to use the product well, and invite a review. Set up the next purchase gently.');
    push('Win-back (send after 30–45 days)', 'We saved your spot', 'Re-engage lapsed buyers with a reason to return — a new arrival or a bundle — and one simple call to action.');
  } else if (archetype === 'b2b_software' || archetype === 'b2b_service' || archetype === 'industrial_b2b') {
    push('Value nurture (day 2–3)', 'The fastest way to ' + (aud ? 'help ' + aud : 'see results'), 'Lead with the buyer problem you solve. Give one concrete insight or mini-case with a number. Soft CTA to a case study or demo.');
    push('Proof (day 5–7)', 'How a ' + (aud || 'client') + ' got results with ' + f.name, 'Tell one named or anonymised customer story: the problem, what you did, the measurable outcome. CTA to book a call.');
    push('Direct offer (day 9–11)', 'Ready to see ' + f.name + ' in action?', 'Recap the core value' + (diff ? ' and your edge (' + diff + ')' : '') + ', remove the top objection, and make one clear ask (demo, call, or trial).');
  } else if (archetype === 'nonprofit') {
    push('Impact story (send within a week)', 'Here is what your support makes possible', 'Tell one concrete beneficiary story with a real outcome. Connect it to the mission. Clear, specific ask to donate or get involved.');
    push('Monthly update', f.name + ' — this month\u2019s impact', 'Short update on progress and numbers, one story, one thank-you, one call to action.');
  } else {
    // local_consumer, professional_practice, real_estate, creator, general
    push('Get to know us (day 2–3)', 'What to expect from ' + f.name, 'Set expectations, show proof' + (f.hasReviews ? ' (' + f.googleRating + '★ reviews)' : '') + ', and make it easy to take the next step' + (f.isLocalPlace ? ' in ' + f.place : '') + '.');
    push('Offer / invitation', (offer ? cap(offer) + ' — ready when you are' : 'Ready when you are'), 'Make one clear, honest offer with a single call to action. Add a review or result as proof.');
    push('Stay in touch (monthly)', 'What\u2019s new at ' + f.name, 'A short monthly note: one update, one helpful tip, one reason to come back. Keeps you top of mind cheaply.');
  }
  return { archetypeLabel: pb.label, intro: 'An email sequence tuned to how a ' + pb.label.toLowerCase() + ' actually converts and retains. Subject lines and outlines are ready — write in your own voice.', emails: emails };
}

// ── 4. Channel strategy ───────────────────────────────────────────────────────
function generateChannelStrategy(f, pb) {
  return {
    archetypeLabel: pb.label,
    summary: pb.strategy,
    cadence: pb.cadence,
    priorities: (pb.channelPriority || []).map(function(pair) { return { channel: pair[0], why: pair[1] }; }),
    primaryChannels: pb.primaryChannels || [],
    contentFormats: pb.contentFormats || []
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
// Called by deliverables.js with a verified-facts bundle. Returns the full
// marketing kit, or null when there is not enough verified information to build
// anything honest.
function generateMarketingKit(rawFacts) {
  var f = normalizeFacts(rawFacts);
  if (!f.name) return null;
  var archetype = classifyMarketingArchetype(f);
  var pb = playbook(archetype);
  var kit = {
    archetype: archetype,
    archetypeLabel: pb.label,
    channelStrategy: generateChannelStrategy(f, pb),
    adCopy: generateAdCopy(f, pb),
    contentCalendar: generateContentCalendar(f, pb),
    emailSequence: generateEmailSequence(f, pb, archetype)
  };
  return kit;
}

module.exports = {
  classifyMarketingArchetype: classifyMarketingArchetype,
  playbook: playbook,
  PLAYBOOKS: PLAYBOOKS,
  normalizeFacts: normalizeFacts,
  generateAdCopy: generateAdCopy,
  generateContentCalendar: generateContentCalendar,
  generateEmailSequence: generateEmailSequence,
  generateChannelStrategy: generateChannelStrategy,
  generateMarketingKit: generateMarketingKit,
  _helpers: { t: t, cap: cap, lower: lower, trimPeriod: trimPeriod, titleCase: titleCase, clampChars: clampChars, firstList: firstList }
};
