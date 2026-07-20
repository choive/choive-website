'use strict';

function logAnthropicUsage(stage, data) {
  var usage = data && data.usage;
  if (!usage || typeof usage !== 'object') return;
  var serverTools = usage.server_tool_use || {};
  console.log('[anthropic-usage] ' + stage + ' ' + JSON.stringify({
    inputTokens: Number(usage.input_tokens || 0),
    outputTokens: Number(usage.output_tokens || 0),
    cacheWriteTokens: Number(usage.cache_creation_input_tokens || 0),
    cacheReadTokens: Number(usage.cache_read_input_tokens || 0),
    webSearches: Number(serverTools.web_search_requests || 0)
  }));
}

module.exports = { logAnthropicUsage: logAnthropicUsage };
