// Service package categories
export const PACKAGE_CATEGORIES = [
  { key: 'full-bar', label: 'Full Bar' },
  { key: 'beer-wine', label: 'Beer & Wine' },
];

// Shared service inclusion text
const SERVICE_INCLUDES = 'Up to four hours of bar service, one professional bartender per 100 guests, full setup and breakdown, cooler to keep drinks cold, a custom menu graphic, and $2 million liquor liability insurance included.';

// Look up a package's detailed sections by its DB slug
export const getPackageBySlug = (slug) => PACKAGES.find(p => p.id === slug) || null;

// Get just the item names from a package's sections (no witty descriptions)
export const getPackageItems = (slug) => {
  const pkg = getPackageBySlug(slug);
  if (!pkg) return null;
  return pkg.sections.map(section => ({
    heading: section.heading,
    items: section.items.map(item => item.split(' – ')[0]),
  }));
};

export const PACKAGES = [
  // ── Full Bar Packages ──
  {
    id: 'the-base-compound',
    name: 'The Base Compound',
    category: 'full-bar',
    tagline: 'Minimal inputs. Maximum efficiency.',
    description: 'A stripped-down formula ideal for casual environments and efficient service — delivering a solid range without experimental overload.',
    sections: [
      {
        heading: 'Spirits',
        items: [
          'Two Signature Cocktails – Pre-formulated in our lab for rapid, reliable deployment. We\'ll help engineer these to match your guest profile, seasonal availability, and personal flavor preferences.',
        ],
      },
      {
        heading: 'Beer & Wine',
        items: [
          'Miller Lite – An American lager classic. Predictable in the best way.',
          'Michelob Ultra – Light, crisp, and beloved by marathon runners and wine moms alike.',
          'One Red Wine – A balanced, medium-bodied red designed for broad appeal and low fuss.',
          'One White Wine – Something bright and approachable — usually a chardonnay or sauv blanc depending on availability.',
        ],
      },
      {
        heading: 'Non-Alcoholic',
        items: [
          'Bottled Water – For hydration and clarity of thought.',
        ],
      },
    ],
    serviceIncludes: SERVICE_INCLUDES,
  },
  {
    id: 'the-midrange-reaction',
    name: 'The Midrange Reaction',
    category: 'full-bar',
    tagline: 'More variables. Still controlled.',
    description: 'This formula expands the spirit selection and mixer profile, offering crowd-pleasing flexibility while staying efficient and focused. Ideal for weddings, milestone events, and hosts who want to level up without losing control of the experiment.',
    sections: [
      {
        heading: 'Spirits',
        items: [
          'Svedka Vodka – Clean and neutral, built to disappear into any mixer.',
          'New Amsterdam Gin – Juniper-forward with citrus undertones. Approachable, especially for gin skeptics.',
          'Bacardi Superior Rum – Light-bodied, mix-friendly, and a tropical workhorse.',
          'Jim Beam Bourbon – Warm, familiar, and built for high-volume mixing. America\'s top-selling bourbon for a reason.',
          'Margaritaville Tequila – Crisp and citrusy, great for sours and spritzes.',
          'Dewar\'s Scotch – A smooth blend with notes of honey and smoke — good for sipping or mixing.',
        ],
      },
      {
        heading: 'Beer & Wine',
        items: [
          'Miller Lite – Consistently drinkable, low-commitment lager.',
          'Michelob Ultra – Light, low-cal, and always socially acceptable.',
          'One Red Wine – Medium-bodied with soft tannins; designed for universal sippability.',
          'One White Wine – Clean and bright; typically a crowd-safe Pinot Grigio or Sauvignon Blanc.',
        ],
      },
      {
        heading: 'Mixers & Modifiers',
        items: [
          'Coke, Diet Coke, and Sprite – The carbonated backbone of most casual cocktails.',
          'Soda Water & Tonic – For lifting, stretching, and expanding spirit flavor profiles.',
          'Cranberry, Orange & Pineapple Juices – Tart and sweet staples, useful in everything from brunch bombs to nightcap hacks.',
        ],
      },
      {
        heading: 'Non-Alcoholic',
        items: [
          'Bottled Water – For clarity, balance, and keeping guests vertical.',
        ],
      },
    ],
    serviceIncludes: SERVICE_INCLUDES,
  },
  {
    id: 'the-enhanced-solution',
    name: 'The Enhanced Solution',
    category: 'full-bar',
    tagline: 'Refined inputs. Amplified output.',
    description: 'Premium spirits. Expanded modifiers. A noticeable bump in complexity and flavor range — for hosts who care about what\'s in the glass without going full molecular mixologist.',
    sections: [
      {
        heading: 'Spirits',
        items: [
          'Tito\'s Vodka – America\'s sweetheart. Corn-based, clean, and perfect in just about anything.',
          'Bombay Sapphire Gin – A bright, botanical punch with hints of spice and citrus.',
          'Bacardi Superior Rum – Crystal clear and ready to disappear into every tropical recipe you throw at it.',
          'Jim Beam Bourbon – Classic Kentucky profile: approachable, warm, and bourbon-purist approved.',
          '1800 Blanco Tequila – Crisp, clean, and balanced — smooth enough for sipping, sharp enough for margaritas.',
          'Johnnie Walker Red Scotch – Peat light, smoke soft. A beginner\'s blend that still plays well in cocktails.',
        ],
      },
      {
        heading: 'Beer & Wine',
        items: [
          'Yuengling Lager – Amber, easy-drinking, and secretly America\'s oldest brewery.',
          'Miller Lite & Michelob Ultra – Crowd favorites with a reputation for going the distance.',
          'Two Red Wines & Two White Wines – Handpicked to suit the event\'s setting, food, and flavor profile.',
          'Sparkling Wine – For bubbles, toasts, or the guests who just like a little fizz.',
        ],
      },
      {
        heading: 'Mixers & Modifiers',
        items: [
          'Coke, Diet Coke, and Sprite – Your foundational fizz trio.',
          'Ginger Ale, Club Soda, Tonic – Balanced carbonation with attitude.',
          'Orange Juice, Cranberry Juice, Pineapple Juice – The sweet acids that do all the heavy lifting.',
          'Simple Syrup, Lemon Juice, Lime Juice, Bitters – Core modifiers for balancing, brightening, or deepening flavor.',
        ],
      },
      {
        heading: 'Non-Alcoholic',
        items: [
          'Bottled Water – Necessary. Essential. Often forgotten until it\'s too late.',
        ],
      },
    ],
    serviceIncludes: SERVICE_INCLUDES,
  },
  {
    id: 'formula-no-5',
    name: 'Formula No. 5',
    category: 'full-bar',
    tagline: 'Precision over excess. Five spirits. Fully dialed.',
    description: 'This tier is about clean lines, deliberate choices, and confident pours. Premium ingredients, zero clutter. A high-end setup for hosts who want quality without overstock.',
    sections: [
      {
        heading: 'Spirits',
        items: [
          'Grey Goose Vodka – Silky, smooth, and always requested by name.',
          'Hendrick\'s Gin – Cucumber and rose petal botanicals, delicate and complex.',
          'Appleton Estate Rum – Deep molasses base with a dry, earthy finish.',
          'Casamigos Tequila – Light oak, smooth agave, and enough backbone to carry a cocktail.',
          'Bulleit Bourbon – Rich and spicy, with a high-rye mash bill and real structure.',
        ],
      },
      {
        heading: 'Beer & Wine',
        items: [
          'Stella Artois – Crisp and clean with just enough sophistication.',
          'One Red Wine & One White Wine – Handpicked for balance and broad appeal.',
        ],
      },
      {
        heading: 'Mixers & Modifiers',
        items: [
          'Coke, Diet Coke, Sprite – Just the essentials.',
          'Ginger Ale, Soda, Tonic – Versatile bases for the spirits in play.',
          'Orange, Cranberry & Pineapple Juices – Sweet-tart fundamentals for builds that need a punch.',
          'Simple Syrup & Bitters – Sweet balance meets subtle depth. Cocktail chemistry in microdoses.',
        ],
      },
      {
        heading: 'Non-Alcoholic',
        items: [
          'Bottled Water – Keeps palates clean, guests upright, and chaos in check.',
        ],
      },
    ],
    serviceIncludes: SERVICE_INCLUDES,
  },
  {
    id: 'the-grand-experiment',
    name: 'The Grand Experiment',
    category: 'full-bar',
    tagline: 'No corners cut. No questions unanswered.',
    description: 'This is the apex formula: a full bar lab experience with celebrated spirits, advanced modifiers, and everything needed to wow even your most opinionated friend who "got into mixology last year."',
    sections: [
      {
        heading: 'Spirits',
        items: [
          'Tito\'s Vodka – Clean, consistent, and smooth enough to win over vodka snobs.',
          'Grey Goose Vodka – Ultra-premium wheat spirit with that famous "oh you fancy" flavor.',
          'Hendrick\'s Gin – Infused with cucumber and rose, this is elegance in a bottle.',
          'Appleton Estate Rum – Bold, aged Jamaican rum with earthy depth and molasses firepower.',
          'Casamigos Tequila – Sleek, modern agave spirit with a soft vanilla finish.',
          'Milagro Reposado Tequila – Aged agave with soft oak and caramel notes. Smooth, balanced, and built for refined palates.',
          'Bulleit Bourbon – Spicy, oaky, and engineered for bold classic builds.',
          'Jameson Irish Whiskey – Triple-distilled crowd-pleaser with honeyed grain and just a touch of green apple.',
          'Monkey Shoulder Scotch – A mellow, malty blend with enough backbone to hold its own in a Rob Roy or rusty nail.',
        ],
      },
      {
        heading: 'Beer & Wine',
        items: [
          'Michelob Ultra – The hydration beer of champions.',
          'Stella Artois – Smooth Euro-lager that elevates your cooler game.',
          'Craft Beer Selection – Rotating, curated, and subject to Dr. Bartender\'s current obsessions.',
          'Two Premium Red Wines & Two Premium White Wines – Handpicked varietals chosen for balance and crowd chemistry. Input optional, trust encouraged.',
          'Sparkling Wine – For toasts, celebration bursts, or the guest who only drinks bubbles.',
        ],
      },
      {
        heading: 'Mixers & Modifiers',
        items: [
          'Coke, Diet Coke, Sprite – The foundation of most long builds.',
          'Club Soda, Tonic Water, Ginger Beer – Fizzy, bitter, and bitey backup.',
          'Orange, Cranberry & Pineapple Juices – Balanced acid and sugar to shape any classic.',
          'Simple Syrup & Bitters – Sweet balance meets subtle depth. Cocktail chemistry in microdoses.',
          'Lemon Juice & Lime Juice – Fresh, tart, and absolutely necessary for precision flavor control.',
        ],
      },
      {
        heading: 'Non-Alcoholic',
        items: [
          'Bottled Water – Keeps palates clean, guests upright, and chaos in check.',
        ],
      },
    ],
    serviceIncludes: SERVICE_INCLUDES,
  },

  // ── Beer & Wine Packages ──
  {
    id: 'the-primary-culture',
    name: 'The Primary Culture',
    category: 'beer-wine',
    tagline: 'Bare Bones. Fully Functional.',
    description: 'A simple yet stable foundation. Great for casual parties and backyard weddings where beer and wine get the job done.',
    sections: [
      {
        heading: 'Beer',
        items: [
          'Miller Lite – Light, smooth, and probably already in someone\'s truck bed.',
          'Michelob Ultra – Low carb, low key, and wildly popular.',
        ],
      },
      {
        heading: 'Wine',
        items: [
          'One Red Wine & One White Wine – Selected by us to please the majority and offend no one.',
        ],
      },
      {
        heading: 'Non-Alcoholic',
        items: [
          'Infused Water Station – Citrus, cucumber, or herbs depending on season and available science.',
        ],
      },
    ],
    serviceIncludes: SERVICE_INCLUDES,
  },
  {
    id: 'the-refined-reaction',
    name: 'The Refined Reaction',
    category: 'beer-wine',
    tagline: 'Polished. Sophisticated. Still streamlined.',
    description: 'A polished experiment in crowd-pleasing sophistication. Still streamlined, but with a noticeable bump in quality — perfect for weddings, cocktail hours, and milestone celebrations.',
    sections: [
      {
        heading: 'Beer',
        items: [
          'Stella Artois – Belgian crispness with a refined finish.',
          'Corona Extra – Refreshing, smooth, and sunshine in a bottle (lime optional, but encouraged).',
        ],
      },
      {
        heading: 'Wine',
        items: [
          'One Red & One White – Thoughtfully selected for balance, body, and universal appeal.',
          'Sparkling Wine – A celebratory control variable: bubbles guaranteed.',
        ],
      },
      {
        heading: 'Non-Alcoholic',
        items: [
          'Bottled Water – Simple, pure, and refreshingly straightforward.',
        ],
      },
    ],
    serviceIncludes: SERVICE_INCLUDES,
  },
  {
    id: 'the-carbon-suspension',
    name: 'The Carbon Suspension',
    category: 'beer-wine',
    tagline: 'Expanded range. Zero pretense.',
    description: 'For bigger crowds or events that need a little more variety — without drifting into fancy territory. Balanced. Approachable. Ready to pour.',
    sections: [
      {
        heading: 'Beer & Seltzer',
        items: [
          'Miller Lite – Your loyal, low-ABV standby.',
          'Michelob Ultra – The crowd favorite that never gets questioned.',
          'Yuengling Lager – Smooth, amber, and unexpectedly complex for the price.',
          'Seltzer – A rotating mix of flavors and brands — bubbly, light, and festival-friendly.',
        ],
      },
      {
        heading: 'Wine',
        items: [
          'Two Red Wines & Two White Wines – We\'ll select easy-drinking varietals that play well with food and avoid polarizing the guest list.',
        ],
      },
      {
        heading: 'Non-Alcoholic',
        items: [
          'Bottled Water – Because the beer people forget it and the wine people suddenly need it.',
        ],
      },
    ],
    serviceIncludes: SERVICE_INCLUDES,
  },
  {
    id: 'the-cultivated-complex',
    name: 'The Cultivated Complex',
    category: 'beer-wine',
    tagline: 'Curated elegance. Lab-certified crowd-pleaser.',
    description: 'Designed for hosts who want elevated beer and wine service with enough sparkle, variety, and quality to make it feel like the full experience — minus the liquor cabinet.',
    sections: [
      {
        heading: 'Beer & Seltzer',
        items: [
          'Miller Lite – Light and sessionable, for folks who pace themselves like pros.',
          'Michelob Ultra – Clean, low-cal, high-popularity per square inch.',
          'Yuengling Lager – A toasty amber classic that satisfies without being heavy.',
          'Two Rotating Craft or Local Beers – Handpicked for regional flavor and a touch of beer snob cred.',
          'Seltzer – Fruity, fizzy, and flavor-flexible. Selected seasonally.',
        ],
      },
      {
        heading: 'Wine',
        items: [
          'Two Premium Red Wines & Two Premium White Wines – Thoughtfully chosen by us for depth, balance, and real event compatibility. No gimmicks — just good wine that works.',
          'Sparkling Wine – Dry, crisp, and celebration-ready.',
        ],
      },
      {
        heading: 'Non-Alcoholic',
        items: [
          'Bottled Water – The universal solvent. Drink it, reset, keep going.',
        ],
      },
    ],
    serviceIncludes: SERVICE_INCLUDES,
  },
];
