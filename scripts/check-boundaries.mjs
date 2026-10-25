import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
const rules = {
  domain: ['domain', 'shared'],
  shared: ['shared'],
  application: ['application', 'domain', 'shared'],
  renderer: ['renderer', 'shared', 'domain'],
  infrastructure: ['infrastructure', 'application', 'domain', 'shared', 'bridge'],
  http: ['http', 'application', 'domain', 'shared'],
};
const problems = [];
async function visit(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await visit(file);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const source = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const layer = file.split(path.sep)[1];
    if (!rules[layer]) continue; // Imported bridge and desktop are platform boundaries.
    function walk(node) {
      if (node.kind === ts.SyntaxKind.AnyKeyword || ts.isNonNullExpression(node))
        problems.push(file + ': any/non-null assertion forbidden in new code');
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        if (spec.startsWith('.')) {
          const target = path
            .relative('src', path.resolve(path.dirname(file), spec))
            .split(path.sep)[0];
          if (!rules[layer].includes(target))
            problems.push(file + ': forbidden dependency ' + spec);
        } else if (
          ['domain', 'shared', 'renderer', 'application'].includes(layer) &&
          /^(node:|electron$|ws$)/.test(spec)
        ) {
          problems.push(file + ': forbidden platform import ' + spec);
        }
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
    if (/[@]ts-(ignore|nocheck)/.test(source.text))
      problems.push(file + ': type suppression forbidden');
  }
}
await visit('src');
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('Architecture boundaries and new-code type rules passed');
