import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import AgreementText from './AgreementText';
import { EVENT_SERVICES_AGREEMENT } from '../../../data/eventServicesAgreement';

describe('AgreementText — in-subset rendering', () => {
  test('renders a ## heading as a heading element', () => {
    const { container } = render(<AgreementText markdown={'## 1. Scope of Services'} />);
    const heading = container.querySelector('h3');
    expect(heading).not.toBeNull();
    expect(heading).toHaveTextContent('1. Scope of Services');
  });

  test('renders a blank-line-separated block as a paragraph', () => {
    const { container } = render(<AgreementText markdown={'First clause text.'} />);
    const p = container.querySelector('p');
    expect(p).not.toBeNull();
    expect(p).toHaveTextContent('First clause text.');
  });

  test('renders **bold** inline as <strong>', () => {
    const { container } = render(<AgreementText markdown={'**1.1 Services.** The rest of the clause.'} />);
    const strong = container.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong).toHaveTextContent('1.1 Services.');
    expect(container.textContent).toContain('The rest of the clause.');
  });

  test('renders a run of "- " lines as a <ul> with <li> items', () => {
    const md = '- First bullet\n- Second bullet';
    const { container } = render(<AgreementText markdown={md} />);
    const items = container.querySelectorAll('ul li');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('First bullet');
    expect(items[1]).toHaveTextContent('Second bullet');
  });

  test('null/undefined markdown renders nothing, does not throw', () => {
    const { container } = render(<AgreementText markdown={undefined} />);
    expect(container.textContent).toBe('');
  });
});

describe('AgreementText — out-of-subset constructs survive as literal text (Warning 6)', () => {
  const cases = [
    ['table row', '| Col A | Col B |', 'table'],
    ['link', '[click here](https://example.com)', 'a'],
    ['image', '![alt text](https://example.com/x.png)', 'img'],
    ['H1 heading', '# Top Level Title', null],
    ['blockquote', '> a quoted line', null],
    ['nested list', '  - indented nested item', 'li'],
    ['italic', '*just italics*', null],
    ['inline code', 'use the `code` token', 'code'],
    ['unmatched bold', 'a stray ** marker stays literal', 'strong'],
    ['raw HTML', '<script>alert(1)</script>', 'script'],
  ];

  test.each(cases)('%s survives as visible text and is not injected', (_label, fixture, forbiddenTag) => {
    const { container } = render(<AgreementText markdown={fixture} />);
    expect(container.textContent).toContain(fixture.trim());
    if (forbiddenTag) {
      expect(container.querySelector(forbiddenTag)).toBeNull();
    }
  });
});

describe('AgreementText — real document', () => {
  test('renders the full agreement without throwing and shows all 23 section headings', () => {
    const { container } = render(<AgreementText markdown={EVENT_SERVICES_AGREEMENT.markdown} />);
    const headings = container.querySelectorAll('h3');
    expect(headings).toHaveLength(23);
    expect(headings[0]).toHaveTextContent('1. Scope of Services');
    expect(headings[22]).toHaveTextContent('23. Headings');
  });

  test('pins the binding dollar figures so an edit cannot silently alter them', () => {
    const { container } = render(<AgreementText markdown={EVENT_SERVICES_AGREEMENT.markdown} />);
    const text = container.textContent;
    expect(text).toContain('$35 fee');
    expect(text).toContain('less a 5% processing fee');
    expect(text).toContain('$100 per hour for the lead bartender plus $40 per hour');
    expect(text).toContain('$50 per bartender per hour');
    expect(text).toContain('$1,000,000 per occurrence and $2,000,000 aggregate');
    expect(text).toContain('below 85% of the signed proposal');
  });
});
