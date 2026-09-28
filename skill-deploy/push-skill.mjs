#!/usr/bin/env node
// Pushes the local ./magnetic-script-engine folder to Anthropic as a NEW VERSION of the
// existing production skill (SKILL_ID). This is the real, hosted skill the app calls — it is
// separate from the skill in Claude's own library, which only affects testing inside Claude.
//
// Run this on your own machine, from this folder:
//   SKILL_ID=skill_01... CLAUDE_API=sk-ant-... node push-skill.mjs
// (ANTHROPIC_API_KEY also works instead of CLAUDE_API, same as server.js.)
//
// Every push sends the WHOLE folder — any file you don't include is dropped from the new
// version, so always run this from a folder that has the complete, current skill in it.
// Server.js is set to skill version "latest", so the very next request after this finishes
// uses the new version automatically — no other change needed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ID = process.env.SKILL_ID;
const API_KEY = process.env.CLAUDE_API || process.env.ANTHROPIC_API_KEY;
const SKILL_DIR = path.join(__dirname, process.argv[2] || 'magnetic-script-engine');

if (!SKILL_ID) { console.error('Missing SKILL_ID env var.'); process.exit(1); }
if (!API_KEY) { console.error('Missing CLAUDE_API (or ANTHROPIC_API_KEY) env var.'); process.exit(1); }
if (!fs.existsSync(path.join(SKILL_DIR, 'SKILL.md'))) {
  console.error(`No SKILL.md found in ${SKILL_DIR}`);
  process.exit(1);
}

// Walk the folder, collect every file with its path relative to SKILL_DIR
// (e.g. "SKILL.md", "references/script-craft.md") — that relative path is what
// tells the API which files are at the root vs inside references/ or scripts/.
function walk(dir, base = '') {
  let out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue; // skip .DS_Store etc.
    const full = path.join(dir, name);
    const rel = path.join(base, name);
    if (fs.statSync(full).isDirectory()) out = out.concat(walk(full, rel));
    else out.push({ full, rel });
  }
  return out;
}

const files = walk(SKILL_DIR);
console.log(`Found ${files.length} file(s) in ${SKILL_DIR}:`);
for (const f of files) console.log('  ' + f.rel);

const form = new FormData();
for (const f of files) {
  const bytes = fs.readFileSync(f.full);
  form.append('files[]', new Blob([bytes]), f.rel);
}

const res = await fetch(`https://api.anthropic.com/v1/skills/${SKILL_ID}/versions`, {
  method: 'POST',
  headers: {
    'anthropic-version': '2023-06-01',
    'x-api-key': API_KEY,
  },
  body: form,
});

const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`\nFailed (${res.status}):`, body.error?.message || JSON.stringify(body));
  process.exit(1);
}

console.log('\nNew skill version created:');
console.log('  version id:', body.id);
console.log('  skill id:  ', body.skill_id);
console.log('  created:   ', body.created_at);
console.log('\nserver.js is set to version "latest", so the next /api/generate call already uses this version.');
