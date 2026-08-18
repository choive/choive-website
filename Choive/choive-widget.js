/**
 * CHOIVE Score Widget
 * 
 * Embeddable widget that displays a business's CHOIVE Score with link to full report.
 * 
 * Usage:
 * <div id="choive-score" data-business="acme-corp" data-score="87"></div>
 * <script src="https://choive.com/choive-widget.js" async></script>
 * 
 * Attributes:
 *   data-business: Business identifier (required)
 *   data-score: CHOIVE Score 0-100 (required)
 *   data-style: 'card' | 'badge' | 'inline' (optional, default: 'card')
 *   data-theme: 'light' | 'dark' (optional, default: 'light')
 *   data-link: 'true' | 'false' (optional, default: 'true') - whether to link to CHOIVE report
 */

(function() {
  'use strict';
  
  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
  function init() {
    const containers = document.querySelectorAll('[id^="choive-score"]');
    containers.forEach(container => renderWidget(container));
  }
  
  function renderWidget(container) {
    const business = container.getAttribute('data-business');
    const score = parseInt(container.getAttribute('data-score'), 10);
    const style = container.getAttribute('data-style') || 'card';
    const theme = container.getAttribute('data-theme') || 'light';
    const shouldLink = container.getAttribute('data-link') !== 'false';
    
    // Validation
    if (!business) {
      console.error('CHOIVE Widget: Missing required attribute data-business');
      return;
    }
    
    if (isNaN(score) || score < 0 || score > 100) {
      console.error('CHOIVE Widget: Invalid data-score. Must be 0-100.');
      return;
    }
    
    // Determine color and label
    let color, label, description;
    if (score >= 80) {
      color = '#10b981';
      label = 'Excellent';
      description = 'Strongly recommended by AI platforms';
    } else if (score >= 60) {
      color = '#f59e0b';
      label = 'Good';
      description = 'Generally recommended by AI platforms';
    } else if (score >= 40) {
      color = '#f97316';
      label = 'Fair';
      description = 'Mixed recommendations from AI platforms';
    } else {
      color = '#ef4444';
      label = 'Needs Work';
      description = 'Rarely recommended by AI platforms';
    }
    
    // Generate widget HTML based on style
    let html;
    
    if (style === 'badge') {
      html = generateBadgeWidget(business, score, color, label, shouldLink);
    } else if (style === 'inline') {
      html = generateInlineWidget(business, score, color, label, shouldLink);
    } else {
      html = generateCardWidget(business, score, color, label, description, theme, shouldLink);
    }
    
    container.innerHTML = html;
  }
  
  function generateCardWidget(business, score, color, label, description, theme, shouldLink) {
    const isDark = theme === 'dark';
    const bgColor = isDark ? '#1f2937' : '#ffffff';
    const textColor = isDark ? '#f9fafb' : '#111827';
    const subtextColor = isDark ? '#d1d5db' : '#6b7280';
    const borderColor = isDark ? '#374151' : '#e5e7eb';
    
    const content = `
      <div style="
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        background-color: ${bgColor};
        color: ${textColor};
        border: 1px solid ${borderColor};
        border-radius: 8px;
        padding: 20px;
        max-width: 300px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      ">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
          <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: ${subtextColor};">
            CHOIVE Score
          </div>
          <div style="font-size: 32px; font-weight: 700; color: ${color};">
            ${score}
          </div>
        </div>
        <div style="margin-bottom: 8px;">
          <div style="font-size: 16px; font-weight: 600; color: ${color}; margin-bottom: 4px;">
            ${label}
          </div>
          <div style="font-size: 13px; line-height: 1.5; color: ${subtextColor};">
            ${description}
          </div>
        </div>
        ${shouldLink ? `
        <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid ${borderColor};">
          <a href="https://choive.com/report#${business}" 
             target="_blank" 
             rel="noopener"
             style="
               font-size: 12px;
               color: ${color};
               text-decoration: none;
               font-weight: 500;
             ">
            View Full Report →
          </a>
        </div>
        ` : ''}
        <div style="margin-top: 12px; font-size: 10px; color: ${subtextColor};">
          Measured by <a href="https://choive.com" target="_blank" rel="noopener" style="color: ${subtextColor}; text-decoration: underline;">CHOIVE</a>
        </div>
      </div>
    `;
    
    return content;
  }
  
  function generateBadgeWidget(business, score, color, label, shouldLink) {
    const badgeImg = `https://choive.com/.netlify/functions/badge?business=${encodeURIComponent(business)}&score=${score}`;
    
    if (shouldLink) {
      return `
        <a href="https://choive.com/report#${business}" target="_blank" rel="noopener">
          <img src="${badgeImg}" alt="CHOIVE Score: ${score}" style="border: 0;">
        </a>
      `;
    } else {
      return `<img src="${badgeImg}" alt="CHOIVE Score: ${score}" style="border: 0;">`;
    }
  }
  
  function generateInlineWidget(business, score, color, label, shouldLink) {
    const content = `
      <span style="
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        font-weight: 500;
      ">
        <span style="color: #6b7280;">CHOIVE Score:</span>
        <span style="color: ${color}; font-weight: 700;">${score}</span>
        <span style="color: ${color};">(${label})</span>
        ${shouldLink ? `
        <a href="https://choive.com/report#${business}" 
           target="_blank" 
           rel="noopener"
           style="color: ${color}; text-decoration: none; margin-left: 4px;">
          ↗
        </a>
        ` : ''}
      </span>
    `;
    
    return content;
  }
})();
