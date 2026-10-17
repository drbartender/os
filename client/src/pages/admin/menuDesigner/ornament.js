import React from 'react';

// The printed menu's rules (spec 2026-10-01 section 11.2; 11.3).
//
// Ornament: the title ornament, a 230 x 14 rule with a center diamond and two
// dots, ported from the 2026-10-01 snapshot's ORN. The size is fixed and the
// color is set directly on the stroke and fills, never through currentColor or
// a CSS variable, because html2canvas serializes the SVG on its own and would
// lose an inherited color.
// GroupHeading: a group heading between its two 46 px hairlines (real
// elements rather than ::before and ::after, so the export never depends on
// pseudo-element support). k is the heading's content key (data-mc-k).

export const ORN_WIDTH = 230;
export const ORN_HEIGHT = 14;
export const ORN = Object.freeze({
  rule: 'M0 7 H96 M134 7 H230',
  diamond: 'M115 1 L121 7 L115 13 L109 7Z',
  dots: [{ cx: 101, cy: 7, r: 1.6 }, { cx: 129, cy: 7, r: 1.6 }],
});

export default function Ornament({ color }) {
  return (
    <svg
      className="mc-orn"
      width={ORN_WIDTH}
      height={ORN_HEIGHT}
      viewBox={`0 0 ${ORN_WIDTH} ${ORN_HEIGHT}`}
      aria-hidden="true"
      focusable="false"
    >
      <path d={ORN.rule} fill="none" stroke={color} strokeWidth="1" />
      <path d={ORN.diamond} fill={color} />
      {ORN.dots.map((d) => <circle key={d.cx} cx={d.cx} cy={d.cy} r={d.r} fill={color} />)}
    </svg>
  );
}

export function GroupHeading({ k, children }) {
  return (
    <div className="mc-gh">
      <span className="mc-hair" />
      <span data-mc-k={k}>{children}</span>
      <span className="mc-hair" />
    </div>
  );
}
