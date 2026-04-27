// ARCHIVED 2026-04-27. One-time migration; do not re-run without reading.
// Original purpose: convert blog post bodies from JSON block arrays to semantic HTML.

/**
 * One-time migration: Convert blog post bodies from JSON blocks to HTML.
 *
 * Usage: node server/scripts/migrateBlogBodies.js
 *
 * This reads all blog_posts, parses the JSON block arrays,
 * converts them to semantic HTML, and updates each row.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { pool } = require('../db');

function blocksToHtml(bodyStr) {
  let blocks;
  try {
    blocks = JSON.parse(bodyStr);
    if (!Array.isArray(blocks)) return bodyStr; // already HTML or plain text
  } catch {
    return bodyStr; // not JSON, leave as-is
  }

  return blocks.map(block => {
    if (block.type === 'heading') {
      const tag = block.level === 'h3' ? 'h3' : 'h2';
      return `<${tag}>${escapeHtml(block.content)}</${tag}>`;
    }

    if (block.type === 'image') {
      const alt = escapeHtml(block.caption || '');
      const caption = block.caption
        ? `<figcaption>${escapeHtml(block.caption)}</figcaption>`
        : '';
      return `<figure><img src="${escapeHtml(block.url)}" alt="${alt}">${caption}</figure>`;
    }

    // Text block — split on double newlines for paragraphs
    const paragraphs = (block.content || '').split(/\n\n+/);
    return paragraphs.map(p => {
      const lines = p.split('\n').map(l => escapeHtml(l)).join('<br>');
      return `<p>${lines}</p>`;
    }).join('\n');
  }).join('\n');
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function migrate() {
  try {
    const { rows } = await pool.query('SELECT id, title, body FROM blog_posts');
    console.log(`Found ${rows.length} posts to migrate.`);

    let migrated = 0;
    let skipped = 0;

    for (const row of rows) {
      // Check if body is JSON blocks (starts with '[')
      const trimmed = (row.body || '').trim();
      if (!trimmed.startsWith('[')) {
        console.log(`  Skipping "${row.title}" — body is not JSON blocks`);
        skipped++;
        continue;
      }

      const html = blocksToHtml(row.body);
      await pool.query('UPDATE blog_posts SET body = $1 WHERE id = $2', [html, row.id]);
      console.log(`  Migrated "${row.title}" (${html.length} chars of HTML)`);
      migrated++;
    }

    console.log(`\nDone. Migrated: ${migrated}, Skipped: ${skipped}`);
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrate();
