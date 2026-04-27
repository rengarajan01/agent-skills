#!/usr/bin/env node
/**
 * generate-skill.js
 *
 * Generates a SKILL.md from any Auth0 SDK JSON reference file.
 * Works for any language or framework — no SDK-specific logic.
 *
 * Usage:
 *   node scripts/generate-skill.js <path-to-sdk-json> [output-path]
 *
 * Examples:
 *   node scripts/generate-skill.js sdk-data/next-auth0/v4/v4.json
 *   node scripts/generate-skill.js sdk-data/auth0-go/v1/v1.json
 *
 * Input layout expected alongside the JSON:
 *   sdk-data/<sdk-name>/<version>/
 *     <version>.json   ← machine-generated API reference
 *     init.md          ← human-authored sections (prerequisites, quick start, common mistakes)
 *
 * The generated SKILL.md = frontmatter + init.md content + auto-generated API reference.
 *
 * To register a new SDK add one entry to PACKAGE_MAP at the bottom of this file.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Markdown helpers ─────────────────────────────────────────────────────────

const B3 = '```';

function codeBlock(code, language = '') {
  return `${B3}${language}\n${code}\n${B3}`;
}

function table(headers, rows) {
  if (!rows.length) return '';
  const header = `| ${headers.join(' | ')} |`;
  const divider = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map(row => `| ${row.join(' | ')} |`).join('\n');
  return [header, divider, body].join('\n');
}

function escape(text) {
  return (text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

// ─── Install command detection ────────────────────────────────────────────────

function installCommand(pkg) {
  if (!pkg) return '';
  if (pkg.startsWith('@') || /^[a-z0-9-]+$/.test(pkg)) return `npm install ${pkg}`;
  if (pkg.startsWith('github.com/') || pkg.startsWith('golang.org/') || pkg.includes('/go-')) return `go get ${pkg}`;
  if (/^[a-z]+\.[a-z]+:[a-z]/.test(pkg)) return `# Maven: add ${pkg} to pom.xml\n# Gradle: implementation '${pkg}'`;
  if (/\.(Net|NET)$/.test(pkg) || pkg.startsWith('Auth0.')) return `dotnet add package ${pkg}`;
  if (pkg.startsWith('pub.dev/') || pkg.endsWith('_flutter')) return `flutter pub add ${pkg}`;
  return `pip install ${pkg}`;
}

// ─── Page renderers ───────────────────────────────────────────────────────────

function renderParams(parameters) {
  if (!parameters?.length) return '';
  const rows = parameters.map(p => [
    `\`${escape(p.name)}\``,
    `\`${escape(p.type)}\``,
    p.optional ? 'No' : 'Yes',
    escape(p.description),
  ]);
  return table(['Parameter', 'Type', 'Required', 'Description'], rows);
}

function renderThrows(throws) {
  if (!throws?.length) return '';
  const rows = throws.map(t => [
    `\`${escape(t.type)}\``,
    t.code ? `\`${escape(t.code)}\`` : '',
    escape(t.description),
  ]);
  return '**Throws:**\n\n' + table(['Error', 'Code', 'Description'], rows);
}

function renderProperties(properties) {
  if (!properties?.length) return '';
  const rows = properties.map(p => [
    `\`${escape(p.name)}\``,
    `\`${escape(p.type)}\``,
    p.optional ? 'No' : 'Yes',
    escape(p.description),
  ]);
  return table(['Property', 'Type', 'Optional', 'Description'], rows);
}

function renderExamples(examples) {
  if (!examples?.length) return '';
  return examples
    .map(e => codeBlock(e.code, e.language ?? ''))
    .join('\n\n');
}

function renderPage(page) {
  const parts = [];

  parts.push(`#### ${page.title} *[${page.kind}]*`);

  if (page.description) parts.push(page.description);

  // Constructor
  if (page.constructor?.signature) {
    parts.push(`**Constructor:** \`${page.constructor.signature}\``);
    const ctorParams = renderParams(page.constructor.parameters);
    if (ctorParams) parts.push(ctorParams);
  }

  // Method / function signature
  if (page.signature && page.kind !== 'class') {
    parts.push(`**Signature:** \`${page.signature}\``);
  }

  // Type alias
  if (page.type && ['type', 'constant'].includes(page.kind)) {
    parts.push(`**Type:** \`${page.type}\``);
  }

  // Parameters
  const params = renderParams(page.parameters);
  if (params) parts.push(`**Parameters:**\n\n${params}`);

  // Returns
  if (page.returns?.description || page.returns?.type) {
    const ret = page.returns;
    parts.push(`**Returns:** \`${ret.type ?? ''}\`${ret.description ? ` — ${ret.description}` : ''}`);
  }

  // Interface properties
  const props = renderProperties(page.properties);
  if (props) parts.push(`**Properties:**\n\n${props}`);

  // Throws
  const throws = renderThrows(page.throws);
  if (throws) parts.push(throws);

  // Examples
  const examples = renderExamples(page.examples);
  if (examples) parts.push(`**Examples:**\n\n${examples}`);

  return parts.join('\n\n');
}

// ─── Quick reference builder ──────────────────────────────────────────────────

function renderQuickReference(navigation, pages) {
  const lines = [];
  for (const section of navigation) {
    const methods = section.items
      .map(item => pages[item.id])
      .filter(p => p && p.signature && ['method', 'function', 'property'].includes(p.kind));

    if (!methods.length) continue;

    lines.push(`**${section.section}:**`);
    for (const p of methods) {
      const sig = p.signature.split('\n')[0];
      const desc = p.returns?.description ?? p.description?.split('\n')[0] ?? '';
      lines.push(`- \`${sig}\`${desc ? ` — ${desc}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ─── Main generator ───────────────────────────────────────────────────────────

function generateSkill(json, initMd, skillName) {
  const { meta, navigation, pages } = json;

  const frontmatter = [
    '---',
    `name: ${skillName}`,
    `description: Auth0 SDK integration skill for ${meta.package}.`,
    'metadata:',
    `  package: ${meta.package}`,
    `  version: ${meta.version}`,
    '---',
  ].join('\n');

  const title = `# ${meta.package} v${meta.version}`;

  const install = [
    '## Installation',
    '',
    codeBlock(installCommand(meta.package), 'bash'),
  ].join('\n');

  // API reference: one section per navigation group
  const apiSections = navigation
    .map(navSection => {
      const renderedPages = navSection.items
        .map(item => pages[item.id])
        .filter(Boolean)
        .map(renderPage)
        .join('\n\n---\n\n');

      if (!renderedPages) return null;

      return [`### ${navSection.section}`, '', renderedPages].join('\n');
    })
    .filter(Boolean)
    .join('\n\n---\n\n');

  const apiReference = ['## API Reference', '', apiSections].join('\n');

  const quickRef = renderQuickReference(navigation, pages);
  const quickRefSection = quickRef
    ? ['## Quick Reference', '', quickRef].join('\n')
    : '';

  // Assemble: init.md is the human-authored guide, JSON drives the reference
  const sections = [
    frontmatter,
    '',
    title,
    '',
    ...(initMd ? [initMd, '', '---', ''] : []),
    install,
    '',
    '---',
    '',
    apiReference,
    '',
    '---',
    '',
    ...(quickRefSection ? [quickRefSection, ''] : []),
  ];

  return sections.join('\n');
}

// ─── Package → skill mapping ──────────────────────────────────────────────────
// Add an entry here whenever you add a new SDK under sdk-data/.

const PACKAGE_MAP = {
  '@auth0/nextjs-auth0':            { skill: 'auth0-nextjs',         plugin: 'auth0-sdks' },
  '@auth0/auth0-react':             { skill: 'auth0-react',          plugin: 'auth0-sdks' },
  '@auth0/auth0-vue':               { skill: 'auth0-vue',            plugin: 'auth0-sdks' },
  '@auth0/auth0-angular':           { skill: 'auth0-angular',        plugin: 'auth0-sdks' },
  '@auth0/auth0-fastify':           { skill: 'auth0-fastify',        plugin: 'auth0-sdks' },
  'express-openid-connect':         { skill: 'auth0-express',        plugin: 'auth0-sdks' },
  'react-native-auth0':             { skill: 'auth0-react-native',   plugin: 'auth0-sdks' },
  'github.com/auth0/go-auth0':      { skill: 'auth0-go',             plugin: 'auth0-sdks' },
  'com.auth0:auth0':                { skill: 'auth0-java',           plugin: 'auth0-sdks' },
  'Auth0.Net':                      { skill: 'auth0-dotnet',         plugin: 'auth0-sdks' },
  'auth0':                          { skill: 'auth0-python',         plugin: 'auth0-sdks' },
  'auth0_flutter':                  { skill: 'auth0-flutter',        plugin: 'auth0-sdks' },
};

// ─── Entry point ──────────────────────────────────────────────────────────────

const jsonPath = process.argv[2];
const outputOverride = process.argv[3];

if (!jsonPath) {
  console.error('Usage: node scripts/generate-skill.js <path-to-sdk-json> [output-path]');
  process.exit(1);
}

const resolvedJson = path.resolve(jsonPath);
if (!fs.existsSync(resolvedJson)) {
  console.error(`File not found: ${resolvedJson}`);
  process.exit(1);
}

const json = JSON.parse(fs.readFileSync(resolvedJson, 'utf-8'));
const entry = PACKAGE_MAP[json.meta.package];

if (!entry) {
  console.error(`Unknown package: ${json.meta.package}`);
  console.error(`Add it to PACKAGE_MAP in scripts/generate-skill.js`);
  console.error(`Known: ${Object.keys(PACKAGE_MAP).join(', ')}`);
  process.exit(1);
}

const initMdPath = path.join(path.dirname(resolvedJson), 'init.md');
const initMd = fs.existsSync(initMdPath)
  ? fs.readFileSync(initMdPath, 'utf-8').trim()
  : '';

const content = generateSkill(json, initMd, entry.skill);

const repoRoot = path.resolve(__dirname, '..');
const outPath = outputOverride
  ? path.resolve(outputOverride)
  : path.join(repoRoot, 'plugins', entry.plugin, 'skills', entry.skill, 'SKILL.md');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, content, 'utf-8');

console.log(`Generated : ${path.relative(repoRoot, outPath)}`);
console.log(`Package   : ${json.meta.package}@${json.meta.version}`);
console.log(`Source    : ${path.relative(repoRoot, resolvedJson)}`);
if (initMd) console.log(`init.md   : included`);
