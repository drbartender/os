'use strict';

// Suite for the schema index (scripts/lib/genDocs/schema.js) over a fixture
// schema holding every statement shape the index reads.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, render } = require('./schema');

const SQL = [
  '-- Fixture schema.',                                                   // 1
  '',                                                                     // 2
  'CREATE OR REPLACE FUNCTION touch_row()',                               // 3
  'RETURNS TRIGGER AS $$',                                                // 4
  'BEGIN',                                                                // 5
  '  NEW.note = NEW.note; -- a ; inside the body',                       // 6
  '  RETURN NEW;',                                                        // 7
  'END;',                                                                 // 8
  "$$ LANGUAGE 'plpgsql';",                                               // 9
  '',                                                                     // 10
  '-- The items table: one row per item.',                                // 11
  '-- Still the first paragraph.',                                        // 12
  '--',                                                                   // 13
  '-- A second paragraph, left out.',                                     // 14
  'CREATE TABLE IF NOT EXISTS items (',                                   // 15
  '  id SERIAL PRIMARY KEY,',                                             // 16
  "  name VARCHAR(100) NOT NULL DEFAULT 'a; b', -- a ; in a comment",     // 17
  '  -- a comment line inside the body',                                  // 18
  '  note TEXT,',                                                         // 19
  '  CONSTRAINT items_name_check CHECK (name <> \'\'),',                  // 20
  '  UNIQUE (name, note)',                                                // 21
  ');',                                                                   // 22
  '',                                                                     // 23
  'CREATE TABLE labels (',                                                // 24
  '  id SERIAL PRIMARY KEY,',                                             // 25
  '  item_id INTEGER REFERENCES items(id),',                              // 26
  '  old_name TEXT,',                                                     // 27
  '  dead TEXT',                                                          // 28
  ');',                                                                   // 29
  '',                                                                     // 30
  "INSERT INTO labels (old_name) VALUES ('x; y');",                       // 31
  'ALTER TABLE items ADD COLUMN IF NOT EXISTS kind VARCHAR(20);',         // 32
  'ALTER TABLE labels',                                                   // 33
  '  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),',     // 34
  '  ADD COLUMN IF NOT EXISTS name TEXT;',                                // 35
  'ALTER TABLE labels DROP COLUMN IF EXISTS dead;',                       // 36
  'ALTER TABLE labels RENAME COLUMN old_name TO title;',                  // 37
  'ALTER TABLE items ADD COLUMN IF NOT EXISTS note TEXT;',                // 38
  'DO $$',                                                                // 39
  'BEGIN',                                                                // 40
  '  -- a ; in a comment inside the block',                               // 41
  '  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = \'labels_item_fkey\') THEN', // 42
  '    ALTER TABLE labels ADD CONSTRAINT labels_item_fkey',               // 43
  '      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE;',  // 44
  '  END IF;',                                                            // 45
  'END $$;',                                                              // 46
  'ALTER TABLE items DROP CONSTRAINT IF EXISTS items_name_check;',        // 47
  "ALTER TABLE items ADD CONSTRAINT items_name_check CHECK (name <> 'z');", // 48
  'ALTER TABLE items ADD CONSTRAINT items_gone_check CHECK (id > 0);',    // 49
  'ALTER TABLE items DROP CONSTRAINT items_gone_check;',                  // 50
  'CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);',            // 51
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_title ON labels (title);', // 52
  'CREATE INDEX IF NOT EXISTS idx_dropped ON items(note);',               // 53
  'DROP INDEX IF EXISTS idx_dropped;',                                    // 54
  'DROP TRIGGER IF EXISTS touch_items ON items;',                         // 55
  'CREATE TRIGGER touch_items BEFORE UPDATE ON items',                    // 56
  '  FOR EACH ROW EXECUTE FUNCTION touch_row();',                         // 57
  '',                                                                     // 58
].join('\n');

test('every CREATE TABLE, in file order, with its line', () => {
  const { tables } = parse(SQL);
  assert.deepEqual(tables.map((t) => [t.name, t.line]), [['items', 15], ['labels', 24]]);
});

test('a described table takes the -- run above it, first paragraph; an undescribed one is empty', () => {
  const { tables } = parse(SQL);
  assert.equal(tables[0].description, 'The items table: one row per item. Still the first paragraph.');
  assert.equal(tables[1].description, '');
});

test('columns from the body and every later ADD COLUMN; a dropped one leaves, a renamed one renames', () => {
  const [items, labels] = parse(SQL).tables;
  assert.deepEqual(items.columns.map((c) => [c.name, c.type, c.line]), [
    ['id', 'SERIAL PRIMARY KEY', 16],
    ['name', "VARCHAR(100) NOT NULL DEFAULT 'a; b'", 17],
    ['note', 'TEXT', 19],
    ['kind', 'VARCHAR(20)', 32],
  ]);
  assert.deepEqual(labels.columns.map((c) => c.name), ['id', 'item_id', 'title', 'created_at', 'name']);
  assert.equal(labels.columns.find((c) => c.name === 'created_at').line, 34);
});

test('constraints: named and unnamed from the body, ADD CONSTRAINT anywhere (a DO block too), a dropped one gone', () => {
  const [items, labels] = parse(SQL).tables;
  assert.deepEqual(items.constraints.map((c) => [c.name, c.lines]), [['items_name_check', [20, 48]], [null, [21]]]);
  assert.equal(items.constraints[1].text, 'UNIQUE (name, note)');
  assert.deepEqual(labels.constraints.map((c) => [c.name, c.lines]), [['labels_item_fkey', [43]]]);
});

test('indexes and triggers with line pointers; a dropped index is gone', () => {
  const [items, labels] = parse(SQL).tables;
  assert.deepEqual(items.indexes, [{ name: 'idx_items_name', lines: [51] }]);
  assert.deepEqual(labels.indexes, [{ name: 'idx_labels_title', lines: [52] }]);
  assert.deepEqual(items.triggers, [{ name: 'touch_items', lines: [56] }]);
});

test('a ; inside a $$ body, a -- comment and a string never splits a statement', () => {
  const { tables } = parse(SQL);
  assert.equal(tables.length, 2);
  assert.ok(tables[0].columns.some((c) => c.type.includes("'a; b'")));
});

test('render: the heading line, then columns, constraints, indexes and triggers', () => {
  assert.equal(render(parse(SQL)), [
    '**items** (server/db/schema.sql:15) The items table: one row per item. Still the first paragraph.',
    "- columns: id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL DEFAULT 'a; b', note TEXT, kind VARCHAR(20)",
    '- constraints: items_name_check (:20, :48), UNIQUE (name, note) (:21)',
    '- indexes: idx_items_name (:51)',
    '- triggers: touch_items (:56)',
    '',
    '**labels** (server/db/schema.sql:24)',
    '- columns: id SERIAL PRIMARY KEY, item_id INTEGER REFERENCES items(id), title TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), name TEXT',
    '- constraints: labels_item_fkey (:43)',
    '- indexes: idx_labels_title (:52)',
  ].join('\n'));
});

test('a long type is cut at 80 characters; an empty line is omitted; an empty file is empty', () => {
  const long = `CREATE TABLE t (\n  id INTEGER CHECK (id IN (${Array.from({ length: 40 }, (_, k) => k).join(', ')}))\n);`;
  const [t] = parse(long).tables;
  assert.equal(t.columns[0].type.length, 80);
  assert.ok(t.columns[0].type.endsWith('...'));
  assert.equal(render(parse(long)).split('\n').length, 2);
  assert.deepEqual(parse('').tables, []);
  assert.equal(render(parse('')), '');
});

const ALTERED = [
  'CREATE TABLE things (',                                                  // 1
  '  id SERIAL PRIMARY KEY,',                                               // 2
  "  name VARCHAR(20) NOT NULL DEFAULT 'a',",                               // 3
  '  note TEXT,',                                                           // 4
  '  kind INTEGER DEFAULT 0,',                                              // 5
  '  label TEXT NULL',                                                      // 6
  ');',                                                                     // 7
  'ALTER TABLE things ALTER COLUMN name TYPE TEXT;',                         // 8
  'ALTER TABLE things ALTER COLUMN name DROP NOT NULL;',                     // 9
  "ALTER TABLE things ALTER COLUMN note SET DEFAULT 'none';",                // 10
  'ALTER TABLE things ALTER COLUMN note SET NOT NULL;',                      // 11
  'ALTER TABLE things ALTER COLUMN kind DROP DEFAULT,',                      // 12
  '  ALTER COLUMN kind TYPE BIGINT USING kind::bigint;',                     // 13
  'ALTER TABLE things ALTER id SET DATA TYPE BIGINT;',                       // 14
  'ALTER TABLE things ALTER COLUMN label SET NOT NULL;',                     // 15
  "ALTER TABLE things ALTER COLUMN label SET DEFAULT 'x';",                  // 16
  "ALTER TABLE things ALTER COLUMN label SET DEFAULT 'y';",                  // 17
  '',
].join('\n');

test('ALTER COLUMN TYPE, SET and DROP DEFAULT, SET and DROP NOT NULL apply in file order, the last line noted', () => {
  const [t] = parse(ALTERED).tables;
  assert.deepEqual(t.columns.map((c) => [c.name, c.type, c.altered]), [
    ['id', 'BIGINT PRIMARY KEY', 14],
    ['name', "TEXT DEFAULT 'a'", 9],
    ['note', "TEXT DEFAULT 'none' NOT NULL", 11],
    ['kind', 'BIGINT', 13],
    ['label', "TEXT NOT NULL DEFAULT 'y'", 17],
  ]);
  assert.equal(render(parse(ALTERED)).split('\n')[1],
    "- columns: id BIGINT PRIMARY KEY (:14), name TEXT DEFAULT 'a' (:9), note TEXT DEFAULT 'none' NOT NULL (:11), kind BIGINT (:13), label TEXT NOT NULL DEFAULT 'y' (:17)");
});

const INLINE = [
  'CREATE TABLE marks (',                                                   // 1
  '  id SERIAL PRIMARY KEY,',                                               // 2
  "  kind VARCHAR(10) DEFAULT 'x' CHECK (kind IN ('x', 'y')),",             // 3
  '  note TEXT CONSTRAINT note_len CHECK (length(note) < 100),',            // 4
  '  name TEXT CHECK (name <> \'\')',                                       // 5
  ');',                                                                     // 6
  'ALTER TABLE marks ADD COLUMN IF NOT EXISTS label TEXT CHECK (label <> \'\');', // 7
  'ALTER TABLE marks DROP CONSTRAINT IF EXISTS marks_kind_check;',          // 8
  "ALTER TABLE marks ADD CONSTRAINT marks_kind_check CHECK (kind IN ('x', 'y', 'z'));", // 9
  'ALTER TABLE marks DROP CONSTRAINT note_len;',                            // 10
  'ALTER TABLE marks DROP CONSTRAINT marks_label_check;',                   // 11
  '',
].join('\n');

test('an inline CHECK goes by its auto-name: dropped by it, it leaves the column text; re-added, it is listed', () => {
  const [t] = parse(INLINE).tables;
  assert.deepEqual(t.columns.map((c) => [c.name, c.type]), [
    ['id', 'SERIAL PRIMARY KEY'],
    ['kind', "VARCHAR(10) DEFAULT 'x'"],
    ['note', 'TEXT'],
    ['name', "TEXT CHECK (name <> '')"],
    ['label', 'TEXT'],
  ]);
  assert.deepEqual(t.constraints.map((c) => [c.name, c.lines]), [['marks_kind_check', [9]]]);
});

const PROBES = [
  'CREATE TABLE probes (',                                                          // 1
  '  id SERIAL PRIMARY KEY,',                                                       // 2
  '  ref_id INTEGER REFERENCES items(id) ON DELETE SET NULL,',                      // 3
  '  note TEXT DEFAULT NULL,',                                                      // 4
  '  label TEXT,',                                                                  // 5
  '  kind INTEGER DEFAULT 0 REFERENCES items(id) ON DELETE SET DEFAULT ON UPDATE CASCADE', // 6
  ');',                                                                             // 7
  'ALTER TABLE probes ALTER COLUMN ref_id SET NOT NULL;',                           // 8
  'ALTER TABLE probes ALTER COLUMN note SET NOT NULL;',                             // 9
  'ALTER TABLE probes ALTER COLUMN label SET DEFAULT NULL;',                        // 10
  'ALTER TABLE probes ALTER COLUMN label DROP DEFAULT;',                            // 11
  'ALTER TABLE probes ALTER COLUMN kind DROP DEFAULT;',                             // 12
  '',
].join('\n');

test('a NULL or DEFAULT inside a REFERENCES action or after DEFAULT is not a clause of its own', () => {
  const [t] = parse(PROBES).tables;
  assert.deepEqual(t.columns.map((c) => [c.name, c.type]), [
    ['id', 'SERIAL PRIMARY KEY'],
    ['ref_id', 'INTEGER REFERENCES items(id) ON DELETE SET NULL NOT NULL'],
    ['note', 'TEXT DEFAULT NULL NOT NULL'],
    ['label', 'TEXT'],
    ['kind', 'INTEGER REFERENCES items(id) ON DELETE SET DEFAULT ON UPDATE CASCADE'],
  ]);
});

const FKEYS = [
  'CREATE TABLE owners (id SERIAL PRIMARY KEY);',                                    // 1
  'CREATE TABLE slots (',                                                            // 2
  '  id SERIAL PRIMARY KEY,',                                                        // 3
  '  created_by INTEGER REFERENCES owners(id),',                                     // 4
  '  note_id INTEGER CONSTRAINT slots_note_link REFERENCES owners(id) ON DELETE CASCADE,', // 5
  '  kept_id INTEGER REFERENCES owners(id) ON DELETE SET NULL',                       // 6
  ');',                                                                              // 7
  'DO $$',                                                                           // 8
  'BEGIN',                                                                           // 9
  "  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slots_created_by_fkey') THEN", // 10
  '    ALTER TABLE slots DROP CONSTRAINT IF EXISTS slots_created_by_fkey;',          // 11
  '    ALTER TABLE slots ADD CONSTRAINT slots_created_by_fkey',                      // 12
  '      FOREIGN KEY (created_by) REFERENCES owners(id) ON DELETE SET NULL;',        // 13
  '  END IF;',                                                                       // 14
  'END $$;',                                                                         // 15
  'ALTER TABLE slots DROP CONSTRAINT slots_note_link;',                              // 16
  '',
].join('\n');

test('an inline REFERENCES goes by its auto-name: dropped, it leaves the column; re-added, it is listed', () => {
  const t = parse(FKEYS).tables.find((x) => x.name === 'slots');
  assert.deepEqual(t.columns.map((c) => [c.name, c.type]), [
    ['id', 'SERIAL PRIMARY KEY'],
    ['created_by', 'INTEGER'],
    ['note_id', 'INTEGER'],
    ['kept_id', 'INTEGER REFERENCES owners(id) ON DELETE SET NULL'],
  ]);
  assert.deepEqual(t.constraints.map((c) => [c.name, c.lines]), [['slots_created_by_fkey', [12]]]);
});

test('a renamed column keeps its inline CHECK under the old auto-name, as Postgres does', () => {
  const sql = [
    'CREATE TABLE marks2 (',
    '  id SERIAL PRIMARY KEY,',
    "  kind TEXT CHECK (kind <> '') REFERENCES owners(id)",
    ');',
    'ALTER TABLE marks2 RENAME COLUMN kind TO sort;',
    'ALTER TABLE marks2 DROP CONSTRAINT marks2_kind_check;',
    'ALTER TABLE marks2 DROP CONSTRAINT IF EXISTS marks2_sort_fkey;',
    '',
  ].join('\n');
  const [t] = parse(sql).tables;
  assert.deepEqual(t.columns.map((c) => [c.name, c.type]), [
    ['id', 'SERIAL PRIMARY KEY'],
    ['sort', 'TEXT REFERENCES owners(id)'],
  ]);
});
