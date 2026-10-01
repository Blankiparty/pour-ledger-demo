'use strict';

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.js'],
  setupFiles: ['<rootDir>/test/setupEnv.js'],
  testTimeout: 20000,
  // Each worker holds one small pool; keep the total well under max_connections.
  maxWorkers: 4,
  verbose: true,
};
