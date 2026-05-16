import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir, cleanup } from './helpers/fixtures.js';
import { loadManifestFile } from '../src/manifest/loader.js';
import { validateDocument, isKnownKind } from '../src/manifest/validator.js';

async function writeYaml(dir: string, name: string, content: string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return file;
}

test('validator: valid workspaces manifest passes', async () => {
  const dir = await makeTempDir();
  try {
    const file = await writeYaml(
      dir,
      'qavor.yaml',
      ['kind: workspaces', 'root_project_path: ./project-repo.git', ''].join('\n'),
    );
    const docs = await loadManifestFile(file);
    assert.equal(docs.length, 1);
    const res = validateDocument(docs[0]!);
    assert.equal(res.ok, true);
  } finally {
    await cleanup(dir);
  }
});

test('validator: invalid project manifest reports file:line:column', async () => {
  const dir = await makeTempDir();
  try {
    const file = await writeYaml(
      dir,
      'qavor.yaml',
      [
        'kind: project',
        'name: Invalid-Name', // uppercase invalid for `name` pattern
        'repositories:',
        '  - ok',
        '',
      ].join('\n'),
    );
    const docs = await loadManifestFile(file);
    const res = validateDocument(docs[0]!);
    assert.equal(res.ok, false);
    const nameIssue = res.issues.find((i) => i.path.endsWith('/name'));
    assert.ok(nameIssue, 'expected a /name issue');
    assert.equal(nameIssue!.file, file);
    assert.ok(nameIssue!.line >= 2, `line should point at the offending field, got ${nameIssue!.line}`);
  } finally {
    await cleanup(dir);
  }
});

test('validator: unknown kind is rejected', async () => {
  const dir = await makeTempDir();
  try {
    const file = await writeYaml(dir, 'qavor.yaml', ['kind: bogus', 'name: foo', ''].join('\n'));
    const docs = await loadManifestFile(file);
    const res = validateDocument(docs[0]!);
    assert.equal(res.ok, false);
    assert.ok(res.issues.some((i) => i.message.includes('Unknown kind')));
  } finally {
    await cleanup(dir);
  }
});

test('loader: multi-document YAML returns one doc per kind', async () => {
  const dir = await makeTempDir();
  try {
    const file = await writeYaml(
      dir,
      'qavor.yaml',
      [
        'kind: repo',
        'name: multi-svc-repo',
        '---',
        'kind: service',
        'name: alpha',
        'runtime:',
        '  native:',
        '    enabled: true',
        '    run:',
        '      cmd: "echo a"',
        '---',
        'kind: service',
        'name: beta',
        'runtime:',
        '  native:',
        '    enabled: true',
        '    run:',
        '      cmd: "echo b"',
        '',
      ].join('\n'),
    );
    const docs = await loadManifestFile(file);
    assert.equal(docs.length, 3);
    assert.equal(docs[0]!.kind, 'repo');
    assert.equal(docs[1]!.kind, 'service');
    assert.equal(docs[2]!.kind, 'service');
    for (const d of docs) {
      assert.equal(validateDocument(d).ok, true, `doc ${d.docIndex} should be valid`);
    }
  } finally {
    await cleanup(dir);
  }
});

test('isKnownKind: enumeration', () => {
  assert.equal(isKnownKind('service'), true);
  assert.equal(isKnownKind('bogus'), false);
  assert.equal(isKnownKind(undefined), false);
});
