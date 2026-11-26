import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_LINES = 800;
const MAX_TOTAL_RAW_LINES = 134000;

const rules = {
  domain: ['domain', 'shared'],
  shared: ['shared'],
  application: ['application', 'domain', 'shared'],
  renderer: ['renderer', 'shared', 'domain'],
  infrastructure: ['infrastructure', 'application', 'domain', 'shared', 'bridge'],
  http: ['http', 'application', 'domain', 'shared'],
  bridge: ['bridge', 'shared', 'domain', 'infrastructure'],
  desktop: ['desktop', 'infrastructure', 'domain', 'shared'],
};

const productionEntrypoints = [
  'src/server.ts',
  'src/desktop/bootstrap.ts',
  'src/desktop/main.ts',
  'src/desktop/preload.cts',
  'src/desktop/server-bootstrap.ts',
  'src/renderer/main.tsx',
  'src/infrastructure/persistence-worker.ts',
  'extension/worker.ts',
  'extension/options.ts',
];

const problems = [];
const codeFiles = new Set();
const allLineCheckedFiles = [];

async function collectFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(file);
      continue;
    }
    if (file.endsWith('.d.ts')) continue;
    if (/\.(ts|tsx|cts|css)$/.test(file)) {
      allLineCheckedFiles.push(file);
    }
    if (/\.(ts|tsx|cts)$/.test(file)) {
      codeFiles.add(path.resolve(file));
    }
  }
}

function resolveLocalCodeImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = /\.(js|jsx|cjs|mjs)$/.test(base)
    ? [
        base.replace(/\.(js|jsx|cjs|mjs)$/, '.ts'),
        base.replace(/\.(js|jsx|cjs|mjs)$/, '.tsx'),
        base.replace(/\.(js|jsx|cjs|mjs)$/, '.cts'),
        base,
      ]
    : [
        base + '.ts',
        base + '.tsx',
        base + '.cts',
        path.join(base, 'index.ts'),
        path.join(base, 'index.tsx'),
      ];
  for (const candidate of candidates) {
    if (codeFiles.has(candidate)) return candidate;
  }
  return null;
}

await collectFiles('src');
await collectFiles('extension');

// Gate 3: max 800 lines across all .ts, .tsx, .cts, .css in src/ and extension/
let totalLines = 0;
for (const file of allLineCheckedFiles) {
  const rawText = await readFile(file, 'utf8');
  const lineCount = rawText.split(/\r?\n/).length;
  totalLines += lineCount;
  if (lineCount > MAX_LINES) {
    problems.push(`${file.replace(/\\/g, '/')}: exceeds ${MAX_LINES} lines (${lineCount})`);
  }
}
if (totalLines > MAX_TOTAL_RAW_LINES) {
  problems.push(`Total raw lines (${totalLines}) exceeds limit (${MAX_TOTAL_RAW_LINES})`);
}

// Gates 1 & 2 + dependency graph collection for Gate 4
const adjacency = new Map();

for (const absFile of codeFiles) {
  const relFile = path.relative(process.cwd(), absFile).replace(/\\/g, '/');
  const rawText = await readFile(absFile, 'utf8');
  const source = ts.createSourceFile(absFile, rawText, ts.ScriptTarget.Latest, true);
  const parts = relFile.split('/');
  const inSrc = parts[0] === 'src';
  const inExtension = parts[0] === 'extension';
  const isRootCompositionFile = inSrc && parts.length === 2 && parts[1] === 'server.ts';
  const layer = inSrc && !isRootCompositionFile ? parts[1] : undefined;

  if (inSrc && !isRootCompositionFile && (!layer || !rules[layer])) {
    problems.push(`${relFile}: unknown architecture layer ${String(layer)}`);
    continue;
  }

  const deps = new Set();

  function walk(node) {
    if (inSrc && (node.kind === ts.SyntaxKind.AnyKeyword || ts.isNonNullExpression(node))) {
      problems.push(`${relFile}: any/non-null assertion forbidden`);
    }
    let spec = null;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      spec = node.moduleSpecifier.text;
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      spec = node.moduleSpecifier.text;
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      spec = node.arguments[0].text;
    }

    if (spec !== null) {
      if (spec.startsWith('.')) {
        const resolved = resolveLocalCodeImport(absFile, spec);
        if (resolved) deps.add(resolved);
        if (inSrc && layer && ts.isImportDeclaration(node)) {
          const target = path
            .relative('src', path.resolve(path.dirname(absFile), spec))
            .split(path.sep)[0];
          if (!rules[layer]?.includes(target)) {
            problems.push(`${relFile}: forbidden dependency ${spec} (${layer} -> ${target})`);
          }
        }
      } else if (inExtension && /^(node:|electron($|\/)|ws($|\/))/.test(spec)) {
        problems.push(`${relFile}: forbidden runtime import ${spec} in extension`);
      } else if (
        inSrc &&
        layer &&
        ['domain', 'shared', 'renderer', 'application'].includes(layer) &&
        /^(node:|electron$|ws$)/.test(spec)
      ) {
        problems.push(`${relFile}: forbidden platform import ${spec}`);
      } else if (inSrc && layer === 'bridge' && /^electron$/.test(spec)) {
        problems.push(`${relFile}: forbidden electron import ${spec}`);
      }
    }
    ts.forEachChild(node, walk);
  }

  walk(source);
  adjacency.set(absFile, [...deps]);

  if (inSrc && /[@]ts-(ignore|nocheck)/.test(source.text)) {
    problems.push(`${relFile}: type suppression forbidden`);
  }
}

// Gate 4: 100% reachability from production entrypoints across src/ and extension/
const visited = new Set();
const queue = [];
for (const entry of productionEntrypoints) {
  const absEntry = path.resolve(entry);
  if (!codeFiles.has(absEntry)) {
    problems.push(`${entry}: missing production entrypoint`);
  } else {
    queue.push(absEntry);
  }
}
while (queue.length > 0) {
  const cur = queue.shift();
  if (visited.has(cur)) continue;
  visited.add(cur);
  for (const nxt of adjacency.get(cur) || []) {
    if (!visited.has(nxt)) queue.push(nxt);
  }
}
for (const absFile of codeFiles) {
  if (!visited.has(absFile)) {
    const relFile = path.relative(process.cwd(), absFile).replace(/\\/g, '/');
    problems.push(`${relFile}: unreachable from production entrypoints`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(
  `Architecture boundaries, <=${MAX_LINES}-line limit, zero-exemption AST rules, and 100% entrypoint reachability passed (${allLineCheckedFiles.length} files, ${totalLines}/${MAX_TOTAL_RAW_LINES} lines)`,
);
