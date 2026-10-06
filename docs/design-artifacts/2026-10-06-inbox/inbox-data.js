// Invented people and messages for the Inbox prototype. "Now" is Tue Oct 6, 2:40 PM (Chicago).
window.InboxData = (function () {
  var CH = {
    thumbtack: 'Thumbtack', text888: 'Text 888', text1922: 'Text 1922', text0082: 'Text 0082',
    email: 'Email', zola: 'Zola', gv: 'Google Voice', staff: 'Staff text'
  };
  var APP = { thumbtack: 'Thumbtack', email: 'Gmail', zola: 'Zola', gv: 'Google Voice' };
  var ICON = { thumbtack: 'card', text888: 'chat', text1922: 'chat', text0082: 'chat', email: 'mail', zola: 'book', gv: 'phone', staff: 'userplus' };

  var people = [
    {
      id: 'priya', name: 'Priya Raman', initials: 'PR', hrs: 67, wait: { n: '2', u: 'DAYS', long: '2 days' },
      need: 'Can you do 180 guests instead of 120?', channels: ['thumbtack'], last: 'thumbtack',
      state: 'promised', stateNote: 'You said Monday', unread: false,
      ctx: {
        chip: { kind: 'info', label: 'Lead' }, type: 'Wedding', guests: 120,
        rows: [
          { label: 'When', value: 'Sat Nov 14 \u00b7 5\u201311 PM' },
          { label: 'Where', value: 'The Larkspur, Evanston' },
          { label: 'Proposal', value: 'Sent Oct 1 \u00b7 viewed 4\u00d7', chip: { kind: 'warn', label: 'Unsigned' } }
        ],
        money: { total: '$3,850', paid: '$0', balance: '$3,850', balSub: 'no deposit yet', settled: false },
        links: ['Client', 'Proposal']
      },
      reply: { mode: 'open', app: 'Thumbtack' },
      thread: [
        { day: 'Sat Oct 3' },
        { dir: 'in', ch: 'thumbtack', time: '7:02 PM', body: 'Hi! Loved the proposal. Our guest list grew, can you do 180 instead of 120? Same date.' },
        { day: 'Sun Oct 4' },
        { dir: 'out', ch: 'thumbtack', time: '1:12 PM', who: 'You', body: "Congrats on the bigger crowd! Let me check staffing for 180 and I'll get back to you Monday." },
        { sys: 'You said you would follow up Monday' },
        { day: 'Mon Oct 5' },
        { dir: 'in', ch: 'thumbtack', time: '6:30 PM', body: "Just checking in on the 180 question. We'd like to sign this week." }
      ]
    },
    {
      id: 'tomas', name: 'Tom\u00e1s Okafor', initials: 'TO', hrs: 46, wait: { n: '46', u: 'HRS', long: '46 hrs' },
      need: 'Add a second bartender and a mocktail station?', channels: ['text1922', 'email'], last: 'text1922',
      state: null, unread: false,
      ctx: {
        chip: { kind: 'ok', label: 'Booked' }, type: 'Wedding', guests: 160,
        rows: [
          { label: 'When', value: 'Sat Oct 24 \u00b7 6\u201311 PM' },
          { label: 'Where', value: 'Ravenswood Event Center, Chicago' },
          { label: 'Proposal', value: 'Signed Sep 12', chip: { kind: 'ok', label: 'Signed' } }
        ],
        money: { total: '$4,200', paid: '$1,000', balance: '$3,200', balSub: 'due Oct 10', settled: false },
        links: ['Client', 'Proposal', 'Event']
      },
      reply: { mode: 'text', line: '1922', phone: '(312) 555-0148' },
      thread: [
        { day: 'Sat Oct 3' },
        { dir: 'in', ch: 'email', time: '10:12 AM', subject: 'Adding to our package', body: "Hi! We're up to 160 now. Could we add a second bartender? My sister doesn't drink, so is a mocktail station something you do?" },
        { dir: 'out', ch: 'email', time: '3:30 PM', who: 'Zul', body: "Hi Tom\u00e1s, yes to both. Let me price it out and I'll send an updated proposal." },
        { day: 'Sun Oct 4' },
        { dir: 'in', ch: 'text1922', time: '4:48 PM', body: "Hey it's Tom\u00e1s. Any update on the second bartender and mocktails? Want to lock it in before the balance is due." }
      ]
    },
    {
      id: 'marcus', name: 'Marcus Bell', initials: 'MB', hrs: 28, wait: { n: '28', u: 'HRS', long: '28 hrs' },
      need: 'Needs a cover for Saturday at the Hartley wedding', channels: ['staff'], last: 'staff',
      state: 'zul', stateNote: 'since Mon 11:02 AM', unread: false,
      ctx: {
        chip: { kind: 'neutral', label: 'Staff' }, type: 'Bartender', guests: null,
        rows: [
          { label: 'Shift', value: 'Sat Oct 10 \u00b7 4\u201311 PM' },
          { label: 'Event', value: 'Hartley wedding, Bridgeport Art Center' },
          { label: 'Roster', value: '3 of 4 after a drop', chip: { kind: 'warn', label: '1 open' } }
        ],
        money: null,
        links: ['Staff profile', 'Shift']
      },
      reply: { mode: 'staff' },
      thread: [
        { day: 'Mon Oct 5' },
        { dir: 'in', ch: 'staff', time: '10:31 AM', body: 'Hey, family thing came up. Can someone cover my Saturday shift at the Hartley wedding? Really sorry.' },
        { sys: 'Zul is on it \u00b7 11:02 AM' }
      ]
    },
    {
      id: 'dana', name: 'Dana Whitfield', initials: 'DW', hrs: 21, wait: { n: '21', u: 'HRS', long: '21 hrs' },
      need: 'Venue needs your certificate of insurance by Friday', channels: ['email'], last: 'email',
      state: null, unread: true,
      ctx: {
        chip: { kind: 'ok', label: 'Booked' }, type: 'Corporate', guests: 80,
        rows: [
          { label: 'When', value: 'Fri Oct 16 \u00b7 5\u20139 PM' },
          { label: 'Where', value: 'Promontory Point, Chicago' },
          { label: 'Proposal', value: 'Signed Aug 30', chip: { kind: 'ok', label: 'Signed' } }
        ],
        money: { total: '$2,600', paid: '$2,600', balance: '$0', balSub: 'paid in full', settled: true },
        links: ['Client', 'Proposal', 'Event']
      },
      reply: { mode: 'open', app: 'Gmail' },
      thread: [
        { day: 'Mon Oct 5' },
        { dir: 'in', ch: 'email', time: '5:40 PM', subject: 'COI for Promontory Point', body: 'Hi! The venue needs a certificate of insurance naming the Chicago Park District by Friday. Can you send it over? Thanks, Dana' }
      ]
    },
    {
      id: 'ruth', name: 'Ruth Castellano', initials: 'RC', hrs: 7, wait: { n: '7', u: 'HRS', long: '7 hrs' },
      need: 'Is the deposit refundable if we move to spring?', channels: ['text888'], last: 'text888',
      state: null, unread: false,
      ctx: {
        chip: { kind: 'ok', label: 'Booked' }, type: 'Anniversary', guests: 110,
        rows: [
          { label: 'When', value: 'Sat Dec 5 \u00b7 7\u201311 PM' },
          { label: 'Where', value: 'Galleria Marchetti, Chicago' },
          { label: 'Proposal', value: 'Signed Sep 2', chip: { kind: 'ok', label: 'Signed' } }
        ],
        money: { total: '$5,100', paid: '$1,500', balance: '$3,600', balSub: 'due Nov 20', settled: false },
        links: ['Client', 'Proposal', 'Event']
      },
      reply: { mode: 'optout', line: '888', optedOut: 'Sep 28', alt: 'Gmail' },
      thread: [
        { day: 'Mon Sep 28' },
        { dir: 'out', ch: 'text888', time: '10:00 AM', who: 'Auto', body: 'Dr. Bartender: your balance of $3,600 is due Nov 20. Reply STOP to opt out.' },
        { dir: 'in', ch: 'text888', time: '10:04 AM', body: 'STOP' },
        { sys: 'Opted out of texts' },
        { day: 'Today' },
        { dir: 'in', ch: 'text888', time: '7:41 AM', body: "Hi, it's Ruth. Is my deposit refundable if we move the date to spring?" }
      ]
    },
    {
      id: 'brandt', name: 'Hannah & Leo Brandt', initials: 'HB', hrs: 4, wait: { n: '4', u: 'HRS', long: '4 hrs' },
      need: 'Do you bring ice, cups and garnishes?', channels: ['zola'], last: 'zola',
      state: null, unread: true,
      ctx: {
        chip: { kind: 'info', label: 'Lead' }, type: 'Wedding', guests: 200,
        rows: [
          { label: 'When', value: 'Sat May 22, 2027' },
          { label: 'Where', value: 'Cuneo Mansion, Vernon Hills' },
          { label: 'Proposal', value: 'Not sent yet', chip: { kind: 'neutral', label: 'None' } }
        ],
        money: null,
        links: ['Client', 'New proposal']
      },
      reply: { mode: 'open', app: 'Zola' },
      thread: [
        { day: 'Today' },
        { dir: 'in', ch: 'zola', time: '10:38 AM', body: 'Hi! Do you bring ice, cups and garnishes, or do we need to buy those ourselves? Thanks! Hannah' }
      ]
    },
    {
      id: 'grace', name: 'Grace Liu', initials: 'GL', hrs: 2, wait: { n: '2', u: 'HRS', long: '1 hr 50 min' },
      need: 'Voicemail: move the tasting to Thursday?', channels: ['gv'], last: 'gv',
      state: null, unread: false,
      ctx: {
        chip: { kind: 'ok', label: 'Booked' }, type: 'Birthday', guests: 60,
        rows: [
          { label: 'When', value: 'Sat Oct 17 \u00b7 7\u201311 PM' },
          { label: 'Where', value: 'Private home, Evanston' },
          { label: 'Tasting', value: 'Wed Oct 7 \u00b7 6 PM' }
        ],
        money: { total: '$1,900', paid: '$500', balance: '$1,400', balSub: 'due Oct 7', settled: false },
        links: ['Client', 'Proposal', 'Event']
      },
      reply: { mode: 'open', app: 'Google Voice' },
      thread: [
        { day: 'Today' },
        { dir: 'in', ch: 'gv', time: '12:50 PM', voicemail: '0:38', body: "Hi, it's Grace Liu. Can we move the tasting to Thursday at six instead? Call me back when you can." }
      ]
    },
    {
      id: 'jordan', name: 'Jordan Pike', initials: 'JP', hrs: 0.4, wait: { n: '26', u: 'MIN', long: '26 min' },
      need: 'Is Oct 31 still open? Ready to book.', channels: ['text888'], last: 'text888',
      state: null, unread: true,
      ctx: {
        chip: { kind: 'info', label: 'New lead' }, type: 'Halloween party', guests: 90,
        rows: [
          { label: 'When', value: 'Sat Oct 31' },
          { label: 'Where', value: 'Oak Park' },
          { label: 'Proposal', value: 'Not sent yet', chip: { kind: 'neutral', label: 'None' } }
        ],
        money: null,
        links: ['Client', 'New proposal']
      },
      reply: { mode: 'text', line: '888', phone: '(708) 555-0193' },
      thread: [
        { day: 'Today' },
        { dir: 'in', ch: 'text888', time: '2:14 PM', body: 'Hi! Found you on Google. Is Oct 31 still open? Ready to book, about 90 guests in Oak Park.' }
      ]
    }
  ];

  var handled = [
    { day: 'Today', items: [
      { id: 'h1', name: 'Keisha Monroe', ch: 'thumbtack', need: 'Wants a quote for 75 guests', reason: 'Proposal sent by Zul', who: 'Z', time: '11:20 AM' },
      { id: 'h2', name: 'Ben Albright', ch: 'email', need: 'Asked about the setup time', reason: 'You emailed back', who: 'D', time: '9:05 AM' },
      { id: 'h3', name: 'Sofia Brennan', ch: 'text888', need: 'Thanks so much for Saturday!', reason: 'AI: just a thank-you', who: 'AI', time: '8:41 AM' }
    ]},
    { day: 'Yesterday', items: [
      { id: 'h4', name: 'Arjun Mehta', ch: 'zola', need: 'Do you serve beer and wine only?', reason: 'Zul replied in Zola', who: 'Z', time: '4:12 PM' },
      { id: 'h5', name: 'Callie Ward', ch: 'text1922', need: 'Can we start at 5 instead of 6?', reason: 'You texted back from 1922', who: 'D', time: '1:30 PM' },
      { id: 'h6', name: 'Owen Fitch', ch: 'staff', need: 'Confirmed for Friday', reason: 'AI: shift confirmation, no reply needed', who: 'AI', time: '9:52 AM' }
    ]},
    { day: 'Sat Oct 3', items: [
      { id: 'h7', name: 'Mira Kowalski', ch: 'thumbtack', need: 'Ready to book the 21st', reason: 'Booked: deposit paid', who: 'AI', time: '6:18 PM' },
      { id: 'h8', name: 'Pete Navarro', ch: 'gv', need: 'Voicemail about parking', reason: 'Zul called back', who: 'Z', time: '2:02 PM' }
    ]},
    { day: 'Thu Oct 1', items: [
      { id: 'h9', name: 'Lena Ortiz', ch: 'email', need: 'Out of office until Monday', reason: 'AI: out-of-office auto-reply', who: 'AI', time: '11:47 AM' },
      { id: 'h10', name: 'The Hollis Group', ch: 'email', need: 'Invoice question', reason: 'You marked it done', who: 'D', time: '10:15 AM' }
    ]}
  ];

  var feeds = [
    { name: 'Thumbtack', ago: '12 min ago', stale: false },
    { name: '888', ago: '3 min ago', stale: false },
    { name: '1922', ago: '2 days ago', stale: true },
    { name: '0082', ago: 'never', stale: true },
    { name: 'Gmail', ago: '4 min ago', stale: false },
    { name: 'Zola', ago: '1 hr ago', stale: false },
    { name: 'Google Voice', ago: '20 min ago', stale: false },
    { name: 'Staff texts', ago: '6 min ago', stale: false }
  ];

  return { CH: CH, APP: APP, ICON: ICON, people: people, handled: handled, feeds: feeds, nowTime: '2:41 PM' };
})();
