import React from 'react';
import styles from './styles';

// Markdown-lite renderer for the Event Services Agreement. Parses a FIXED subset
// into React elements — no dangerouslySetInnerHTML, no new dependency. Subset:
//   "## heading"        -> styled section heading
//   blank-line blocks   -> <p style={styles.contractText}>
//   runs of "- " lines  -> <ul><li style={styles.contractListItem}>
//   "**bold**" inline   -> <strong>
// Anything outside the subset (tables, links, images, # H1, > blockquotes,
// nested/indented lists, *italic*, inline code, unmatched **, raw HTML) passes
// through as LITERAL paragraph text — never dropped, never raw-injected, never
// throws (spec Warning 6). Heading/bullet detection runs on the RAW line (no
// trim), so an indented "  - x" is NOT a bullet — it falls through to a paragraph
// and its literal dash survives.

const isHeading = (line) => /^##\s+/.test(line);
const isBullet = (line) => /^-\s+/.test(line);

// Split a line into nodes on matched **bold** pairs. Unmatched ** and single *
// are left as literal text.
function renderInline(text, keyPrefix) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  return parts
    .map((part, i) => {
      if (part === '') return null;
      if (/^\*\*[^*]+\*\*$/.test(part)) {
        return <strong key={`${keyPrefix}-s${i}`}>{part.slice(2, -2)}</strong>;
      }
      return <React.Fragment key={`${keyPrefix}-t${i}`}>{part}</React.Fragment>;
    })
    .filter(Boolean);
}

export default function AgreementText({ markdown }) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line — skip.
    if (line.trim() === '') { i += 1; continue; }

    // Section heading.
    if (isHeading(line)) {
      const text = line.replace(/^##\s+/, '').trim();
      blocks.push(
        <h3 key={`h-${key}`} style={styles.agreementHeading}>{renderInline(text, `h-${key}`)}</h3>
      );
      key += 1;
      i += 1;
      continue;
    }

    // Bullet list: a run of consecutive top-of-line "- " lines.
    if (isBullet(line)) {
      const items = [];
      while (i < lines.length && isBullet(lines[i])) {
        const itemText = lines[i].replace(/^-\s+/, '').trim();
        items.push(
          <li key={`li-${key}`} style={styles.contractListItem}>{renderInline(itemText, `li-${key}`)}</li>
        );
        key += 1;
        i += 1;
      }
      blocks.push(<ul key={`ul-${key}`} style={styles.contractList}>{items}</ul>);
      key += 1;
      continue;
    }

    // Otherwise a paragraph: this line plus following non-blank, non-heading,
    // non-bullet lines, joined by a space.
    const paraLines = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i].trim() !== '' && !isHeading(lines[i]) && !isBullet(lines[i])) {
      paraLines.push(lines[i].trim());
      i += 1;
    }
    blocks.push(
      <p key={`p-${key}`} style={styles.contractText}>{renderInline(paraLines.join(' '), `p-${key}`)}</p>
    );
    key += 1;
  }

  return <>{blocks}</>;
}
