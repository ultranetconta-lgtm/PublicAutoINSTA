const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appSource = readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');

test('list view puts the next scheduled date and time first', () => {
  const sort = appSource.match(/const orderedPosts\s*=\s*filtered\.slice\(\)\.sort\(([^;]+)\);/);
  assert.ok(sort, 'renderListView must define its post ordering');
  const compare = new Function('scheduleTimestamp', `return ${sort[1]}`)(post => post.timestamp);
  const posts = [
    { id: 'tomorrow', timestamp: 3 },
    { id: 'later-today', timestamp: 2 },
    { id: 'soonest-today', timestamp: 1 },
  ];

  assert.deepEqual(posts.sort(compare).map(post => post.id), [
    'soonest-today',
    'later-today',
    'tomorrow',
  ]);
});

test('live schedule inserts use the same upcoming-first order', () => {
  const appendStart = appSource.indexOf('function appendScheduleRows(posts)');
  const listStart = appSource.indexOf('function renderListView()', appendStart);
  assert.notEqual(appendStart, -1, 'appendScheduleRows must exist');
  assert.notEqual(listStart, -1, 'renderListView must follow appendScheduleRows');
  const appendSource = appSource.slice(appendStart, listStart);

  assert.match(
    appendSource,
    /\.sort\(\s*\(a,\s*b\)\s*=>\s*scheduleTimestamp\(a\)\s*-\s*scheduleTimestamp\(b\)\s*\)/,
  );
  assert.match(
    appendSource,
    /scheduleTimestamp\(post\)\s*<\s*scheduleTimestamp\(existingPost\)/,
  );
  assert.match(appendSource, /scheduleDateKey\s*>\s*dateKey/);
});
