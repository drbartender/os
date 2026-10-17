import React from 'react';
import { render } from '@testing-library/react';
import Ornament, { GroupHeading, ORN_WIDTH, ORN_HEIGHT } from './ornament';

test('a fixed 230 x 14 rule, diamond and two dots, colored directly', () => {
  const { container } = render(<Ornament color="#8a6a2f" />);
  const svg = container.querySelector('svg');
  expect(ORN_WIDTH).toBe(230);
  expect(ORN_HEIGHT).toBe(14);
  expect(svg.getAttribute('width')).toBe('230');
  expect(svg.getAttribute('height')).toBe('14');
  expect(svg.getAttribute('aria-hidden')).toBe('true');
  const [rule, diamond] = svg.querySelectorAll('path');
  expect(rule.getAttribute('stroke')).toBe('#8a6a2f');
  expect(diamond.getAttribute('fill')).toBe('#8a6a2f');
  const dots = svg.querySelectorAll('circle');
  expect(dots).toHaveLength(2);
  dots.forEach((d) => expect(d.getAttribute('fill')).toBe('#8a6a2f'));
  // Never currentColor: html2canvas serializes the SVG on its own.
  expect(container.innerHTML).not.toMatch(/currentColor/i);
});

test('a group heading sits between two hairlines and carries its content key', () => {
  const { container } = render(<GroupHeading k="headings.sig">Signature Cocktails</GroupHeading>);
  const gh = container.querySelector('.mc-gh');
  expect(gh.querySelectorAll('.mc-hair')).toHaveLength(2);
  expect(gh.children[1].getAttribute('data-mc-k')).toBe('headings.sig');
  expect(gh.children[1].textContent).toBe('Signature Cocktails');
});
