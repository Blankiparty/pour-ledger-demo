'use strict';

/** @type {import('drizzle-kit').Config} */
module.exports = {
  dialect: 'postgresql',
  schema: './src/db/schema.js',
  out: './drizzle',
};
