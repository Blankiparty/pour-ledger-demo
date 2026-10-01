'use strict';

const { createHash } = require('node:crypto');

// Stable JSON: object keys sorted at every level, so {"a":1,"b":2} and
// {"b":2,"a":1} hash the same. Arrays keep their order.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function requestHash(body) {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

module.exports = { canonicalJson, requestHash };
