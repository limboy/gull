#!/usr/bin/env node
/*
 * Generates CHANGELOG.md from git tags + conventional commits.
 * Run: node scripts/generate-changelog.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_URL = 'https://github.com/limboy/gull';

const GROUPS = [
  { type: 'feat',     title: 'Features' },
  { type: 'fix',      title: 'Bug Fixes' },
  { type: 'perf',     title: 'Performance' },
  { type: 'refactor', title: 'Refactoring' },
  { type: 'docs',     title: 'Documentation' },
  { type: 'style',    title: 'Styles' },
  { type: 'test',     title: 'Tests' },
  { type: 'build',    title: 'Build' },
  { type: 'ci',       title: 'CI' },
  { type: 'chore',    title: 'Chores' },
];
const KNOWN_TYPES = new Set(GROUPS.map(g => g.type));

const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

function getTags() {
  const raw = sh('git tag --list "v*" --sort=-creatordate');
  if (!raw) return [];
  return raw.split('\n').filter(Boolean);
}

function getTagDate(tag) {
  return sh(`git log -1 --format=%ad --date=short ${tag}`);
}

function getCommits(range) {
  const fmt = '%H%x1f%s%x1f%b%x1e';
  const out = sh(`git log ${range} --no-merges --format=${fmt}`);
  if (!out) return [];
  return out.split('\x1e').map(s => s.trim()).filter(Boolean).map(entry => {
    const [hash, subject, body] = entry.split('\x1f');
    return { hash, subject: subject || '', body: body || '' };
  });
}

function parseCommit(c) {
  // type(scope)!: subject
  const m = c.subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
  if (!m) return null;
  const [, type, scope, bang, desc] = m;
  const breaking = !!bang || /BREAKING CHANGE:/.test(c.body);
  return { type: type.toLowerCase(), scope, desc, breaking, hash: c.hash };
}

function formatCommit(p) {
  const short = p.hash.slice(0, 7);
  const scope = p.scope ? `**${p.scope}:** ` : '';
  const bang = p.breaking ? ' ⚠️' : '';
  return `- ${scope}${p.desc} ([${short}](${REPO_URL}/commit/${p.hash}))${bang}`;
}

function renderSection(header, dateStr, commits) {
  const parsed = commits.map(parseCommit).filter(Boolean);
  if (parsed.length === 0) return '';

  const breaking = parsed.filter(p => p.breaking);
  const byType = new Map();
  for (const p of parsed) {
    if (!KNOWN_TYPES.has(p.type)) continue;
    if (!byType.has(p.type)) byType.set(p.type, []);
    byType.get(p.type).push(p);
  }

  const lines = [`## ${header}${dateStr ? ` - ${dateStr}` : ''}`, ''];

  if (breaking.length) {
    lines.push('### ⚠️ BREAKING CHANGES', '');
    for (const p of breaking) lines.push(formatCommit(p));
    lines.push('');
  }

  for (const g of GROUPS) {
    const items = byType.get(g.type);
    if (!items || items.length === 0) continue;
    lines.push(`### ${g.title}`, '');
    for (const p of items) lines.push(formatCommit(p));
    lines.push('');
  }

  return lines.join('\n');
}

function main() {
  const tags = getTags();
  const sections = [];

  // Unreleased: HEAD vs latest tag
  const latest = tags[0];
  const unreleasedRange = latest ? `${latest}..HEAD` : 'HEAD';
  const unreleasedCommits = getCommits(unreleasedRange);
  if (unreleasedCommits.length) {
    const s = renderSection(
      latest ? `[Unreleased](${REPO_URL}/compare/${latest}...HEAD)` : 'Unreleased',
      '',
      unreleasedCommits
    );
    if (s) sections.push(s);
  }

  // Tagged releases
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    const prev = tags[i + 1];
    const range = prev ? `${prev}..${tag}` : tag;
    const commits = getCommits(range);
    const date = getTagDate(tag);
    const header = prev
      ? `[${tag}](${REPO_URL}/compare/${prev}...${tag})`
      : `[${tag}](${REPO_URL}/releases/tag/${tag})`;
    const s = renderSection(header, date, commits);
    if (s) sections.push(s);
  }

  const content = [
    '# Changelog',
    '',
    'All notable changes to this project are documented here.',
    'This file is generated automatically from [Conventional Commits](https://www.conventionalcommits.org/) — run `npm run changelog` to regenerate.',
    '',
    sections.join('\n'),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

  const out = path.resolve(__dirname, '..', 'CHANGELOG.md');
  fs.writeFileSync(out, content);
  console.log(`Wrote ${out} (${sections.length} section${sections.length === 1 ? '' : 's'})`);

  // Write RELEASENOTES.md (only the latest tagged release)
  // we skip the "Unreleased" section if it exists at index 0
  const releaseNotesIndex = unreleasedCommits.length && sections.length > 1 ? 1 : 0;
  if (sections[releaseNotesIndex]) {
    // For RELEASENOTES.md, we don't want the "## [v1.2.6](...)" header
    // but rather just the content. Or maybe a simpler header.
    // Let's strip the first line (the header) for GitHub Release Body
    const lines = sections[releaseNotesIndex].split('\n');
    const body = lines.slice(2).join('\n').trim(); // Skip header and empty line
    const notesPath = path.resolve(__dirname, '..', 'RELEASENOTES.md');
    fs.writeFileSync(notesPath, body);
    console.log(`Wrote ${notesPath}`);
  }
}

main();
