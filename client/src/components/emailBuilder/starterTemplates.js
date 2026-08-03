// Ready-made designed-email starters. Each returns a fresh array of blocks
// (with new ids) so the owner can pick one and edit rather than start blank.
import { makeBlock } from './blockCatalog';

// Helper: build a block of `type` then merge in overrides for its props.
function block(type, props) {
  const b = makeBlock(type);
  b.props = { ...b.props, ...props };
  return b;
}

export const TEMPLATES = [
  {
    key: 'newsletter',
    name: 'Monthly newsletter',
    description: 'Headline, a story, a photo, and a call to action.',
    build: () => [
      block('heading', { text: "What's pouring this month", level: 'h1', align: 'center' }),
      block('text', { html: '<p>Hi there,</p><p>Here’s what’s new at Dr. Bartender — a fresh seasonal menu, a few open dates, and a cocktail you can try at home.</p>' }),
      block('image', { src: '', alt: 'Seasonal cocktail', align: 'center', width: 'full' }),
      block('heading', { text: 'Cocktail of the month', level: 'h3', align: 'left' }),
      block('text', { html: '<p>A short description of the featured drink — what’s in it and why guests love it.</p>' }),
      block('button', { label: 'See our packages', href: 'https://drbartender.com' }),
    ],
  },
  {
    key: 'promo',
    name: 'Promotion / offer',
    description: 'A bold hero banner with a single strong call to action.',
    build: () => [
      block('hero', {
        src: '', alt: 'Event bar',
        heading: 'Book your holiday party early',
        subtext: 'Reserve your date now and save 10% on any bartending package booked this month.',
        buttonLabel: 'Claim the offer', buttonHref: 'https://drbartender.com',
      }),
      block('divider', {}),
      block('text', { html: '<p>Offer valid for new bookings only. Dates are filling fast for the season — reply to this email and we’ll hold your date.</p>' }),
    ],
  },
  {
    key: 'event',
    name: 'Event follow-up',
    description: 'Thank a lead and nudge them toward booking.',
    build: () => [
      block('heading', { text: 'Great meeting you!', level: 'h2', align: 'left' }),
      block('text', { html: '<p>Hi there,</p><p>Thanks for reaching out about your event. We’d love to be behind the bar for it. Here’s a quick look at what we offer.</p>' }),
      block('columns', {
        left: { src: '', alt: 'BYOB', html: '<p><strong>BYOB service</strong><br/>You provide the alcohol, we handle the rest.</p>' },
        right: { src: '', alt: 'Hosted', html: '<p><strong>Fully hosted</strong><br/>We take care of everything, start to finish.</p>' },
      }),
      block('button', { label: 'View your proposal', href: 'https://drbartender.com' }),
    ],
  },
  {
    key: 'blank',
    name: 'Blank',
    description: 'Start from an empty canvas.',
    build: () => [],
  },
];
