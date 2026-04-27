// ARCHIVED 2026-04-27. One-time migration; do not re-run without reading.
// Original purpose: import blog posts from blog_posts.json + upload images to R2 (block-format era, pre-HTML).

/**
 * Import blog posts from blog_posts.json into the database.
 *
 * Converts plain-text bodies into the block-based format used by the blog editor:
 *   [{ type: 'heading', content, level }, { type: 'text', content }, { type: 'image', url, caption }]
 *
 * Also uploads images from the blog-import/images folder to R2.
 *
 * Usage:  node server/scripts/importBlogPosts.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { uploadFile } = require('../utils/storage');

const IMPORT_DIR = path.resolve(__dirname, '../..', 'blog-import');
const JSON_PATH = path.join(IMPORT_DIR, 'blog_posts.json');
const IMAGES_DIR = path.join(IMPORT_DIR, 'images');

// ---------------------------------------------------------------------------
// Parse a plain-text post body into an array of blocks
// ---------------------------------------------------------------------------
function parseBodyToBlocks(text) {
  const blocks = [];

  // Split on double-newlines to get paragraphs / sections
  const sections = text.split(/\n{2,}/);

  for (const raw of sections) {
    const section = raw.trim();
    if (!section) continue;

    // Detect headings — single-line sections that are short and don't end
    // with a period (typical of titles / section headers in these posts)
    const lines = section.split('\n').map(l => l.trim()).filter(Boolean);

    if (
      lines.length === 1 &&
      section.length < 100 &&
      !section.endsWith('.') &&
      !section.startsWith('"') &&
      !section.startsWith('\u201C')
    ) {
      blocks.push({ type: 'heading', content: section, level: 'h2' });
    } else {
      blocks.push({ type: 'text', content: section });
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Upload an image file to R2 and return the API URL
// ---------------------------------------------------------------------------
async function uploadImage(localPath) {
  const fullPath = path.join(IMAGES_DIR, path.basename(localPath));
  if (!fs.existsSync(fullPath)) {
    console.warn(`    Image not found: ${fullPath}`);
    return null;
  }
  const data = fs.readFileSync(fullPath);
  const ext = path.extname(localPath);
  const filename = `blog_${uuidv4()}${ext}`;
  await uploadFile(data, filename);
  return `/api/blog/images/${filename}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!fs.existsSync(JSON_PATH)) {
    console.error('blog_posts.json not found at', JSON_PATH);
    process.exit(1);
  }

  const posts = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  console.log(`Found ${posts.length} posts to import.\n`);

  for (let postIndex = 0; postIndex < posts.length; postIndex++) {
    const post = posts[postIndex];
    const postNum = postIndex + 1;
    console.log(`Processing: "${post.title}"`);

    // Upload cover image (cover-post1.webp, cover-post2.webp, etc.)
    const coverFilename = `cover-post${postNum}.webp`;
    const coverPath = path.join(IMAGES_DIR, coverFilename);
    let coverUrl = null;
    if (fs.existsSync(coverPath)) {
      coverUrl = await uploadImage(coverFilename);
      console.log(`    Uploaded cover: ${coverFilename}`);
    }

    // Parse body text into blocks
    const blocks = parseBodyToBlocks(post.body);

    // Upload inline images and build image blocks with R2 URLs
    const imageBlocks = [];
    for (const img of (post.images || [])) {
      const url = await uploadImage(img.local_path);
      if (url) {
        imageBlocks.push({ type: 'image', url, caption: img.alt || '' });
        console.log(`    Uploaded: ${img.local_path}`);
      }
    }

    // Distribute images after heading blocks where possible
    let imageIdx = 0;
    const finalBlocks = [];
    for (const block of blocks) {
      finalBlocks.push(block);
      if (block.type === 'heading' && imageIdx < imageBlocks.length) {
        finalBlocks.push(imageBlocks[imageIdx]);
        imageIdx++;
      }
    }
    // Append any remaining images at the end
    while (imageIdx < imageBlocks.length) {
      finalBlocks.push(imageBlocks[imageIdx]);
      imageIdx++;
    }

    const body = JSON.stringify(finalBlocks);

    // Build excerpt from first text block
    const firstText = finalBlocks.find(b => b.type === 'text');
    const excerpt = firstText
      ? firstText.content.slice(0, 200).replace(/\n/g, ' ').trim() + '...'
      : '';

    try {
      const result = await pool.query(
        `INSERT INTO blog_posts (title, slug, excerpt, body, cover_image_url, published, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (slug) DO NOTHING
         RETURNING id`,
        [post.title, post.slug, excerpt, body, coverUrl, true, new Date(post.date)]
      );

      if (result.rows.length) {
        console.log(`  ✓ Imported (id ${result.rows[0].id})\n`);
      } else {
        console.log(`  – Skipped (slug already exists)\n`);
      }
    } catch (err) {
      console.error(`  ✗ Failed:`, err.message, '\n');
    }
  }

  console.log('Done.');
  await pool.end();
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
