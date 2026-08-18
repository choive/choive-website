
'use strict';

const STANDARD_NAME = 'CHOIVE AI Selection Standard';
const STANDARD_VERSION = '3.0';
const RUBRIC_VERSION = 'evidence-rubric-v3';
const METHODOLOGY_URL = 'https://choive.com/methodology';

function measurementProvenance(measuredAt) {
  return {
    name: STANDARD_NAME,
    version: STANDARD_VERSION,
    rubricVersion: RUBRIC_VERSION,
    methodologyUrl: METHODOLOGY_URL,
    measuredAt: measuredAt || new Date().toISOString()
  };
}

module.exports = { STANDARD_NAME, STANDARD_VERSION, RUBRIC_VERSION, METHODOLOGY_URL, measurementProvenance };
