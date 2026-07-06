import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { buildWorkspaceRegistry, discoverManifestFiles } from '../src/manifest/discovery.js';
import { loadManifestFile } from '../src/manifest/loader.js';
import { isKnownKind, validateDocument } from '../src/manifest/validator.js';
import { cleanup, makeTempDir } from './helpers/fixtures.js';

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
    assert.equal(nameIssue?.file, file);
    assert.ok(
      nameIssue?.line >= 2,
      `line should point at the offending field, got ${nameIssue?.line}`,
    );
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

test('loader: multi-document YAML returns one doc per document', async () => {
  const dir = await makeTempDir();
  try {
    const file = await writeYaml(
      dir,
      'qavor.yaml',
      [
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
    assert.equal(docs.length, 2);
    assert.equal(docs[0]?.kind, 'service');
    assert.equal(docs[1]?.kind, 'service');
    for (const d of docs) {
      assert.equal(validateDocument(d).ok, true, `doc ${d.docIndex} should be valid`);
    }
  } finally {
    await cleanup(dir);
  }
});

test('validator: list-form runtime step (multiple commands) passes', async () => {
  const dir = await makeTempDir();
  try {
    const file = await writeYaml(
      dir,
      'qavor.yaml',
      [
        'kind: service',
        'name: multi',
        'runtime:',
        '  native:',
        '    enabled: true',
        '    prepare:',
        '      - cmd: "echo one"',
        '      - cmd: "echo two"',
        '        cwd: sub',
        '    run:',
        '      cmd: "echo run"',
        '',
      ].join('\n'),
    );
    const docs = await loadManifestFile(file);
    assert.equal(validateDocument(docs[0]!).ok, true);
  } finally {
    await cleanup(dir);
  }
});

test('validator: empty list-form step and item missing cmd are rejected', async () => {
  const dir = await makeTempDir();
  try {
    const emptyFile = await writeYaml(
      dir,
      'empty.yaml',
      [
        'kind: service',
        'name: emptylist',
        'runtime:',
        '  native:',
        '    enabled: true',
        '    prepare: []', // minItems: 1 — must fail
        '',
      ].join('\n'),
    );
    const emptyDocs = await loadManifestFile(emptyFile);
    assert.equal(validateDocument(emptyDocs[0]!).ok, false, 'empty list should be rejected');

    const noCmdFile = await writeYaml(
      dir,
      'nocmd.yaml',
      [
        'kind: service',
        'name: nocmd',
        'runtime:',
        '  native:',
        '    enabled: true',
        '    prepare:',
        '      - cwd: sub', // missing required `cmd`
        '',
      ].join('\n'),
    );
    const noCmdDocs = await loadManifestFile(noCmdFile);
    assert.equal(validateDocument(noCmdDocs[0]!).ok, false, 'list item without cmd should fail');
  } finally {
    await cleanup(dir);
  }
});

test('validator: a described command ({ description, operations }) passes', async () => {
  const dir = await makeTempDir();
  try {
    const file = await writeYaml(
      dir,
      'qavor.yaml',
      [
        'kind: service',
        'name: described',
        'runtime:',
        '  native:',
        '    enabled: true',
        '    build:',
        '      description: "Compile the service."',
        '      operations:',
        '        cmd: "echo build"',
        '    update_libraries:',
        '      description: "Upgrade and re-sync dependencies."',
        '      operations:',
        '        - cmd: "echo upgrade"',
        '        - cmd: "echo sync"',
        '',
      ].join('\n'),
    );
    const docs = await loadManifestFile(file);
    assert.equal(validateDocument(docs[0]!).ok, true);
  } finally {
    await cleanup(dir);
  }
});

test('validator: a described command without `operations` is rejected', async () => {
  const dir = await makeTempDir();
  try {
    const file = await writeYaml(
      dir,
      'qavor.yaml',
      [
        'kind: service',
        'name: baddescribed',
        'runtime:',
        '  native:',
        '    enabled: true',
        '    build:',
        '      description: "Compile the service."', // missing required `operations`
        '',
      ].join('\n'),
    );
    const docs = await loadManifestFile(file);
    assert.equal(validateDocument(docs[0]!).ok, false);
  } finally {
    await cleanup(dir);
  }
});

test('validator: a described command with a non-string description is rejected', async () => {
  const dir = await makeTempDir();
  try {
    const file = await writeYaml(
      dir,
      'qavor.yaml',
      [
        'kind: service',
        'name: baddescribed2',
        'runtime:',
        '  native:',
        '    enabled: true',
        '    build:',
        '      description: true', // must be a string
        '      operations:',
        '        cmd: "echo build"',
        '',
      ].join('\n'),
    );
    const docs = await loadManifestFile(file);
    assert.equal(validateDocument(docs[0]!).ok, false);
  } finally {
    await cleanup(dir);
  }
});

test('validator: profile-merge directive on a command passes', async () => {
  const dir = await makeTempDir();
  try {
    const file = await writeYaml(
      dir,
      'qavor.yaml',
      [
        'kind: service',
        'name: merge',
        'profiles: [base]',
        'runtime:',
        '  native:',
        '    prepare: { $append: [ { cmd: "echo extra" } ] }',
        '    lint: { $prepend: [ { cmd: "echo first" } ] }',
        '    migrate: { $unset: true }',
        '',
      ].join('\n'),
    );
    const docs = await loadManifestFile(file);
    assert.equal(validateDocument(docs[0]!).ok, true);
  } finally {
    await cleanup(dir);
  }
});

test('validator: malformed merge directives are rejected', async () => {
  const dir = await makeTempDir();
  try {
    // Two directive keys at once — oneOf requires exactly one.
    const twoKeys = await writeYaml(
      dir,
      'two.yaml',
      [
        'kind: service',
        'name: two',
        'runtime:',
        '  native:',
        '    prepare: { $append: [ { cmd: a } ], $prepend: [ { cmd: b } ] }',
        '',
      ].join('\n'),
    );
    assert.equal(validateDocument((await loadManifestFile(twoKeys))[0]!).ok, false);

    // $unset must be the constant `true`.
    const badUnset = await writeYaml(
      dir,
      'unset.yaml',
      [
        'kind: service',
        'name: unset',
        'runtime:',
        '  native:',
        '    prepare: { $unset: false }',
        '',
      ].join('\n'),
    );
    assert.equal(validateDocument((await loadManifestFile(badUnset))[0]!).ok, false);

    // `run` is single-step only — directives are not allowed on it.
    const runDirective = await writeYaml(
      dir,
      'run.yaml',
      [
        'kind: service',
        'name: rundir',
        'runtime:',
        '  native:',
        '    run: { $append: [ { cmd: a } ] }',
        '',
      ].join('\n'),
    );
    assert.equal(validateDocument((await loadManifestFile(runDirective))[0]!).ok, false);
  } finally {
    await cleanup(dir);
  }
});

test('discoverManifestFiles: finds nested manifests up to MAX_DEPTH (5)', async () => {
  const dir = await makeTempDir();
  try {
    await writeYaml(dir, 'qavor.yaml', 'kind: project\nname: root\n');
    // depth 5: a/b/c/d/e/qavor.yaml — at the cap, must be found.
    const atCapDir = path.join(dir, 'a', 'b', 'c', 'd', 'e');
    await fs.mkdir(atCapDir, { recursive: true });
    const atCap = await writeYaml(atCapDir, 'qavor.yaml', 'kind: profile\nname: deep\n');
    // depth 6: one past the cap, intentionally not discovered.
    const pastCapDir = path.join(atCapDir, 'f');
    await fs.mkdir(pastCapDir, { recursive: true });
    const pastCap = await writeYaml(pastCapDir, 'qavor.yaml', 'kind: profile\nname: toodeep\n');

    const found = await discoverManifestFiles(dir);
    assert.ok(found.includes(atCap), `depth-5 manifest not discovered: ${found.join(', ')}`);
    assert.ok(!found.includes(pastCap), 'depth-6 manifest should be beyond MAX_DEPTH');
  } finally {
    await cleanup(dir);
  }
});

test('discoverManifestFiles: still prunes SKIP_DIRS like node_modules', async () => {
  const dir = await makeTempDir();
  try {
    const buried = path.join(dir, 'node_modules', 'pkg');
    await fs.mkdir(buried, { recursive: true });
    const skipped = await writeYaml(buried, 'qavor.yaml', 'kind: profile\nname: skip\n');
    const found = await discoverManifestFiles(dir);
    assert.ok(!found.includes(skipped), 'manifest under node_modules should be skipped');
  } finally {
    await cleanup(dir);
  }
});

test('buildWorkspaceRegistry: a repo reachable under two keys is scanned once', async () => {
  const dir = await makeTempDir();
  try {
    const profDir = path.join(dir, 'profiles', 'node-library');
    await fs.mkdir(profDir, { recursive: true });
    await writeYaml(profDir, 'qavor.yaml', 'kind: profile\nname: node_library\n');

    // Same directory under two keys: its repo name and the project sentinel.
    const registry = await buildWorkspaceRegistry({
      workspaceRoot: dir,
      repos: new Map([
        ['workspace', dir],
        ['__project__', dir],
      ]),
    });

    const profiles = registry.entries.filter((e) => e.kind === 'profile');
    assert.equal(profiles.length, 1, 'profile should be loaded exactly once');
    assert.equal(
      registry.issues.length,
      0,
      `unexpected issues: ${JSON.stringify(registry.issues)}`,
    );
  } finally {
    await cleanup(dir);
  }
});

test('isKnownKind: enumeration', () => {
  assert.equal(isKnownKind('service'), true);
  assert.equal(isKnownKind('bogus'), false);
  assert.equal(isKnownKind(undefined), false);
});
