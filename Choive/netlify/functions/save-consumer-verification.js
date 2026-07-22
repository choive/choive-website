'use strict';

const crypto = require('crypto');
const { getDiagnostic, updateDiagnosticResult } = require('./lib/supabase');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};
const PLATFORMS = ['claude', 'chatgpt', 'perplexity', 'gemini'];

function clean(value, max) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, max);
}

function sameHash(a, b) {
  var left = Buffer.from(String(a || ''), 'utf8');
  var right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    var body = JSON.parse(event.body || '{}');
    var jobId = clean(body.jobId, 80);
    var token = clean(body.verificationToken, 128);
    if (!/^[0-9a-f-]{36}$/i.test(jobId) || !token) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing verification details' }) };
    }

    var diagnostic = await getDiagnostic(jobId);
    if (!diagnostic || diagnostic.status !== 'complete' || !diagnostic.result) {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'The diagnostic is not ready' }) };
    }
    var expected = diagnostic.input && diagnostic.input._consumerVerificationTokenHash;
    var supplied = crypto.createHash('sha256').update(token).digest('hex');
    if (!expected || !sameHash(expected, supplied)) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'This browser cannot edit that result' }) };
    }

    var platform = clean(body.platform, 30).toLowerCase();
    var recommendation = clean(body.recommendation, 180);
    var transcript = clean(body.transcript, 12000);
    var question = clean(body.question, 1000);
    if (PLATFORMS.indexOf(platform) === -1 || !recommendation || transcript.length < 20 || !question) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Add the complete answer and confirm the recommended name' }) };
    }

    var result = Object.assign({}, diagnostic.result);
    var existing = result.consumerAppVerification && typeof result.consumerAppVerification === 'object'
      ? result.consumerAppVerification : {};
    existing[platform] = {
      platform: platform === 'chatgpt' ? 'ChatGPT' : platform.charAt(0).toUpperCase() + platform.slice(1),
      recommendation: recommendation,
      transcript: transcript,
      question: question,
      verifiedAt: new Date().toISOString(),
      provenance: 'consumer_app_user_supplied'
    };
    result.consumerAppVerification = existing;
    await updateDiagnosticResult(jobId, result);

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, record: existing[platform] }) };
  } catch (error) {
    console.error('save-consumer-verification:', error.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not save the consumer-app answer' }) };
  }
};
