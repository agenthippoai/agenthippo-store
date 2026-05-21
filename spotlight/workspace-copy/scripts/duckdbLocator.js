#!/usr/bin/env node
/* Copyright (c) AgentHippo.ai. All rights reserved. */

const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function findDuckdb() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || '';
  const candidates = [
    'duckdb',
    'duckdb.exe',
    path.join(home, '.agent-hippo', 'bin', 'duckdb.exe'),
    path.join(home, '.agent-hippo', 'bin', 'duckdb'),
    '/opt/homebrew/bin/duckdb',
    '/usr/local/bin/duckdb',
  ];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

module.exports = { findDuckdb };
