/* @ds-bundle: {"format":4,"namespace":"DrBartenderOSDesignSystem_720350","components":[{"name":"CommandPalette","sourcePath":"components/command/CommandPalette.jsx"},{"name":"KebabMenu","sourcePath":"components/command/KebabMenu.jsx"},{"name":"Icon","sourcePath":"components/icon/Icon.jsx"},{"name":"ICON_NAMES","sourcePath":"components/icon/Icon.jsx"},{"name":"AreaChart","sourcePath":"components/metrics/AreaChart.jsx"},{"name":"MetricTile","sourcePath":"components/metrics/MetricTile.jsx"},{"name":"MetricsFilterBar","sourcePath":"components/metrics/MetricsFilterBar.jsx"},{"name":"Sparkline","sourcePath":"components/metrics/Sparkline.jsx"},{"name":"Header","sourcePath":"components/navigation/Header.jsx"},{"name":"DEFAULT_NAV","sourcePath":"components/navigation/Sidebar.jsx"},{"name":"Sidebar","sourcePath":"components/navigation/Sidebar.jsx"},{"name":"Toolbar","sourcePath":"components/navigation/Toolbar.jsx"},{"name":"DocumentPreviewModal","sourcePath":"components/overlay/DocumentPreviewModal.jsx"},{"name":"Drawer","sourcePath":"components/overlay/Drawer.jsx"},{"name":"NextEventCard","sourcePath":"components/staff/NextEventCard.jsx"},{"name":"PayoutRow","sourcePath":"components/staff/PayoutRow.jsx"},{"name":"ShiftRow","sourcePath":"components/staff/ShiftRow.jsx"},{"name":"STAFF_TABS","sourcePath":"components/staff/StaffTabBar.jsx"},{"name":"StaffTabBar","sourcePath":"components/staff/StaffTabBar.jsx"},{"name":"StaffUserPillMenu","sourcePath":"components/staff/StaffUserPillMenu.jsx"},{"name":"StaffPills","sourcePath":"components/status/StaffPills.jsx"},{"name":"StatusChip","sourcePath":"components/status/StatusChip.jsx"},{"name":"DataTableRow","sourcePath":"components/table/DataTableRow.jsx"}],"sourceHashes":{"components/command/CommandPalette.jsx":"49dbf88d8b4c","components/command/KebabMenu.jsx":"d14aeb0457de","components/icon/Icon.jsx":"a87fc69a4be2","components/metrics/AreaChart.jsx":"2a00c89b7ec7","components/metrics/MetricTile.jsx":"c383a1b175c1","components/metrics/MetricsFilterBar.jsx":"34926f96669a","components/metrics/Sparkline.jsx":"4f69a6db8889","components/navigation/Header.jsx":"49c96e7ac2a8","components/navigation/Sidebar.jsx":"90a8d84cc944","components/navigation/Toolbar.jsx":"195c8efae693","components/overlay/DocumentPreviewModal.jsx":"f70861273a43","components/overlay/Drawer.jsx":"c507133544bd","components/staff/NextEventCard.jsx":"482991da1a23","components/staff/PayoutRow.jsx":"357026252d7d","components/staff/ShiftRow.jsx":"67f14d63b7f8","components/staff/StaffTabBar.jsx":"4bfd5c2f9269","components/staff/StaffUserPillMenu.jsx":"c50ef7de88d4","components/status/StaffPills.jsx":"a067bdc84559","components/status/StatusChip.jsx":"b533991cd6f9","components/table/DataTableRow.jsx":"f1f8d1839b9c","ui_kits/admin/screens.jsx":"094143f23758","ui_kits/staff/screens.jsx":"903308ca46d3"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.DrBartenderOSDesignSystem_720350 = window.DrBartenderOSDesignSystem_720350 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/icon/Icon.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
// Dr. Bartender OS icon set — Lucide-style inline SVG, 24×24 viewBox, stroke 1.75.
// The house glyph vocabulary used across admin + staff. Reproduced verbatim
// from client/src/components/adminos/Icon.js.
const ICONS = {
  home: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1V9.5Z"
  })),
  calendar: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "5",
    width: "18",
    height: "16",
    rx: "2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M3 9h18M8 3v4M16 3v4"
  })),
  clipboard: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
    x: "5",
    y: "4",
    width: "14",
    height: "17",
    rx: "2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M9 4h6v3H9zM9 12h6M9 16h4"
  })),
  users: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "9",
    cy: "8",
    r: "3.5"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "17",
    cy: "9",
    r: "2.5"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M15 20c0-2.5 1.5-4.5 4-5"
  })),
  userplus: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "9",
    cy: "8",
    r: "3.5"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M19 7v6M22 10h-6"
  })),
  dollar: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M12 3v18M16 7c0-1.7-1.8-3-4-3s-4 1.3-4 3 1.8 3 4 3 4 1.3 4 3-1.8 3-4 3-4-1.3-4-3"
  })),
  pen: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M4 20h4l10-10-4-4L4 16v4Z"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M14 6l4 4"
  })),
  mail: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "5",
    width: "18",
    height: "14",
    rx: "2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "m3 7 9 6 9-6"
  })),
  chat: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.5A8 8 0 1 1 21 12Z"
  })),
  gear: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"
  })),
  search: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "11",
    cy: "11",
    r: "7"
  }), /*#__PURE__*/React.createElement("path", {
    d: "m20 20-3.5-3.5"
  })),
  plus: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M12 5v14M5 12h14"
  })),
  bell: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M6 8a6 6 0 1 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9Z"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M10 21a2 2 0 0 0 4 0"
  })),
  filter: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M3 5h18l-7 9v5l-4 2v-7L3 5Z"
  })),
  sort: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M7 4v16M4 17l3 3 3-3M17 20V4M14 7l3-3 3 3"
  })),
  down: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("polyline", {
    points: "6 9 12 15 18 9"
  })),
  right: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("polyline", {
    points: "9 6 15 12 9 18"
  })),
  left: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("polyline", {
    points: "15 6 9 12 15 18"
  })),
  up: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("polyline", {
    points: "18 15 12 9 6 15"
  })),
  x: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M6 6l12 12M18 6 6 18"
  })),
  check: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("polyline", {
    points: "5 12 10 17 19 7"
  })),
  clock: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "9"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 7v5l3 2"
  })),
  pin: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M12 21v-6"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M8 3h8l-1 5 4 4H5l4-4-1-5Z"
  })),
  location: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M12 22s7-6 7-12a7 7 0 1 0-14 0c0 6 7 12 7 12Z"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "10",
    r: "2.5"
  })),
  phone: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M5 4c0 9 6 15 15 15l1-4-5-2-2 2c-2-1-4-3-5-5l2-2-2-5-4 1Z"
  })),
  external: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M10 5H5v14h14v-5M14 4h6v6M20 4l-9 9"
  })),
  copy: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
    x: "8",
    y: "8",
    width: "12",
    height: "12",
    rx: "2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"
  })),
  trend_up: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("polyline", {
    points: "3 17 9 11 13 15 21 7"
  }), /*#__PURE__*/React.createElement("polyline", {
    points: "14 7 21 7 21 14"
  })),
  trend_down: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("polyline", {
    points: "3 7 9 13 13 9 21 17"
  }), /*#__PURE__*/React.createElement("polyline", {
    points: "14 17 21 17 21 10"
  })),
  alert: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M12 3 2 21h20L12 3Z"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 10v5M12 18v.5"
  })),
  sparkles: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"
  })),
  grip: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "9",
    cy: "6",
    r: "1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "15",
    cy: "6",
    r: "1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "9",
    cy: "12",
    r: "1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "15",
    cy: "12",
    r: "1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "9",
    cy: "18",
    r: "1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "15",
    cy: "18",
    r: "1"
  })),
  kebab: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "5",
    r: "1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "19",
    r: "1"
  })),
  logout: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M10 17l-5-5 5-5M5 12h12M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5"
  })),
  eye: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "3"
  })),
  flask: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M9 3h6M10 3v6L5 20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1l-5-11V3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M7 14h10"
  })),
  book: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M4 19a2 2 0 0 0 2 2h13"
  })),
  list: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"
  })),
  card: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "6",
    width: "18",
    height: "13",
    rx: "2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M3 11h18"
  })),
  panel: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "3",
    width: "18",
    height: "18",
    rx: "2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M9 3v18"
  })),
  arrow_right: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M5 12h14M13 6l6 6-6 6"
  })),
  send: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M4 12 21 4l-7 17-3-7-7-2Z"
  })),
  sun: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "4"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"
  })),
  moon: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M20 15.5A8 8 0 0 1 8.5 4a8 8 0 1 0 11.5 11.5Z"
  })),
  chart: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "12",
    width: "4",
    height: "8"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "10",
    y: "7",
    width: "4",
    height: "13"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "17",
    y: "3",
    width: "4",
    height: "17"
  })),
  menu: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M4 7h16M4 12h16M4 17h16"
  }))
};

/**
 * Icon — renders a named glyph from the OS icon set. Inherits currentColor.
 */
function Icon({
  name,
  size = 14,
  ...rest
}) {
  const paths = ICONS[name];
  if (!paths) return null;
  return /*#__PURE__*/React.createElement("svg", _extends({
    xmlns: "http://www.w3.org/2000/svg",
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.75",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true"
  }, rest), paths);
}
const ICON_NAMES = Object.keys(ICONS);
Object.assign(__ds_scope, { Icon, ICON_NAMES });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/icon/Icon.jsx", error: String((e && e.message) || e) }); }

// components/command/CommandPalette.jsx
try { (() => {
const {
  useState
} = React;
const DEFAULT_GROUPS = [{
  group: 'Jump to',
  items: [{
    label: 'Dashboard',
    icon: 'home'
  }, {
    label: 'Events',
    icon: 'calendar'
  }, {
    label: 'Proposals',
    icon: 'clipboard'
  }, {
    label: 'Clients',
    icon: 'users'
  }, {
    label: 'Staff',
    icon: 'userplus'
  }, {
    label: 'Financials',
    icon: 'dollar'
  }, {
    label: 'Drink Plans',
    icon: 'flask'
  }, {
    label: 'Cocktail Menu',
    icon: 'book'
  }, {
    label: 'Settings',
    icon: 'gear'
  }]
}, {
  group: 'Create',
  items: [{
    label: 'New proposal',
    icon: 'plus'
  }, {
    label: 'New campaign',
    icon: 'plus'
  }]
}];

/**
 * CommandPalette — the ⌘K overlay. Fuzzy-filters navigation + create actions
 * (and any record results you pass). Renders inside the nearest positioned
 * ancestor so it stays within the app shell in a mock.
 */
function CommandPalette({
  open,
  onClose = () => {},
  groups = DEFAULT_GROUPS,
  onSelect = () => {}
}) {
  const [q, setQ] = useState('');
  if (!open) return null;
  const filtered = groups.map(g => ({
    ...g,
    items: g.items.filter(it => !q || it.label.toLowerCase().includes(q.toLowerCase()))
  })).filter(g => g.items.length);
  return /*#__PURE__*/React.createElement("div", {
    className: "palette-scrim open",
    onClick: onClose,
    role: "dialog",
    "aria-modal": "true",
    "aria-label": "Command palette"
  }, /*#__PURE__*/React.createElement("div", {
    className: "palette",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    className: "palette-input"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "search"
  }), /*#__PURE__*/React.createElement("input", {
    autoFocus: true,
    placeholder: "Search clients, proposals, events, staff\u2026",
    value: q,
    onChange: e => setQ(e.target.value),
    "aria-label": "Command search"
  }), /*#__PURE__*/React.createElement("span", {
    className: "kbd"
  }, "Esc")), /*#__PURE__*/React.createElement("div", {
    className: "palette-list scroll-thin"
  }, filtered.map(g => /*#__PURE__*/React.createElement("div", {
    key: g.group
  }, /*#__PURE__*/React.createElement("div", {
    className: "palette-group-label"
  }, g.group), g.items.map(it => /*#__PURE__*/React.createElement("div", {
    key: it.label,
    className: "palette-item",
    role: "button",
    tabIndex: 0,
    onClick: () => {
      onSelect(it);
      onClose();
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: it.icon
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", null, it.label), it.detail && /*#__PURE__*/React.createElement("div", {
    className: "palette-item-sub"
  }, it.detail)), /*#__PURE__*/React.createElement("div", {
    className: "shortcut"
  }, /*#__PURE__*/React.createElement("span", {
    className: "kbd"
  }, "\u21B5")))))), !filtered.length && /*#__PURE__*/React.createElement("div", {
    className: "palette-item muted"
  }, "No results."))));
}
Object.assign(__ds_scope, { CommandPalette });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/command/CommandPalette.jsx", error: String((e && e.message) || e) }); }

// components/command/KebabMenu.jsx
try { (() => {
const {
  useEffect,
  useRef,
  useState
} = React;
/**
 * KebabMenu — the 3-dots-vertical overflow action menu used in table rows.
 * Toggles an anchored dropdown; each item may carry an icon, a danger tone, a
 * disabled state, and either an onClick or an href.
 */
function KebabMenu({
  items = []
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onOutside = e => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onEsc = e => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);
  return /*#__PURE__*/React.createElement("span", {
    ref: wrapRef,
    style: {
      position: 'relative',
      display: 'inline-flex'
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "icon-btn",
    onClick: e => {
      e.stopPropagation();
      setOpen(o => !o);
    },
    title: "More actions",
    "aria-haspopup": "menu",
    "aria-expanded": open
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "kebab"
  })), open && /*#__PURE__*/React.createElement("div", {
    className: "kebab-menu",
    role: "menu",
    style: {
      position: 'absolute',
      top: 'calc(100% + 4px)',
      right: 0,
      zIndex: 1000
    },
    onClick: e => e.stopPropagation()
  }, items.map((item, i) => {
    const Cmp = item.href && !item.disabled ? 'a' : 'button';
    return /*#__PURE__*/React.createElement(Cmp, {
      key: i,
      role: "menuitem",
      className: `kebab-item ${item.danger ? 'danger' : ''}`,
      href: item.href && !item.disabled ? item.href : undefined,
      "aria-disabled": item.disabled ? 'true' : undefined,
      disabled: Cmp === 'button' ? item.disabled : undefined,
      onClick: () => {
        if (!item.disabled) {
          setOpen(false);
          item.onClick?.();
        }
      }
    }, item.icon && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
      name: item.icon,
      size: 13
    }), /*#__PURE__*/React.createElement("span", null, item.label));
  })));
}
Object.assign(__ds_scope, { KebabMenu });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/command/KebabMenu.jsx", error: String((e && e.message) || e) }); }

// components/metrics/AreaChart.jsx
try { (() => {
/**
 * AreaChart — two-series filled SVG area chart used on the dashboard. First key
 * is "primary" (accent), second is "secondary" (ok/teal, dashed). Gradients
 * fade each area toward transparent. Scales to container width.
 */
function AreaChart({
  data = [],
  w = 720,
  h = 180,
  keys = ['booked', 'collected']
}) {
  if (!data.length) return null;
  const max = Math.max(...data.flatMap(d => keys.map(k => d[k] || 0))) * 1.1 || 1;
  const pts = key => data.map((d, i) => [i * (w / (data.length - 1 || 1)), h - (d[key] || 0) / max * (h - 24) - 12]);
  const path = arr => arr.reduce((s, [x, y], i) => s + (i ? ` L ${x} ${y}` : `M ${x} ${y}`), '');
  const area = arr => path(arr) + ` L ${w} ${h} L 0 ${h} Z`;
  const uid = React.useId ? React.useId().replace(/:/g, '') : 'ac';
  return /*#__PURE__*/React.createElement("svg", {
    viewBox: `0 0 ${w} ${h}`,
    width: "100%",
    height: h,
    preserveAspectRatio: "none",
    style: {
      display: 'block'
    }
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("linearGradient", {
    id: `gP${uid}`,
    x1: "0",
    x2: "0",
    y1: "0",
    y2: "1"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0",
    stopColor: "var(--accent)",
    stopOpacity: "0.4"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "1",
    stopColor: "var(--accent)",
    stopOpacity: "0"
  })), /*#__PURE__*/React.createElement("linearGradient", {
    id: `gS${uid}`,
    x1: "0",
    x2: "0",
    y1: "0",
    y2: "1"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0",
    stopColor: "hsl(var(--ok-h) var(--ok-s) 52%)",
    stopOpacity: "0.3"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "1",
    stopColor: "hsl(var(--ok-h) var(--ok-s) 52%)",
    stopOpacity: "0"
  }))), [0.25, 0.5, 0.75].map(p => /*#__PURE__*/React.createElement("line", {
    key: p,
    x1: "0",
    x2: w,
    y1: h * p,
    y2: h * p,
    stroke: "var(--line-1)",
    strokeDasharray: "2 4"
  })), /*#__PURE__*/React.createElement("path", {
    d: area(pts(keys[0])),
    fill: `url(#gP${uid})`
  }), /*#__PURE__*/React.createElement("path", {
    d: path(pts(keys[0])),
    fill: "none",
    stroke: "var(--accent)",
    strokeWidth: 1.5
  }), /*#__PURE__*/React.createElement("path", {
    d: area(pts(keys[1])),
    fill: `url(#gS${uid})`
  }), /*#__PURE__*/React.createElement("path", {
    d: path(pts(keys[1])),
    fill: "none",
    stroke: "hsl(var(--ok-h) var(--ok-s) 52%)",
    strokeWidth: "1.5",
    strokeDasharray: "0"
  }), data.map((d, i) => /*#__PURE__*/React.createElement("text", {
    key: i,
    x: i * (w / (data.length - 1 || 1)),
    y: h - 2,
    fontSize: "10",
    fill: "var(--ink-4)",
    textAnchor: "middle",
    fontFamily: "var(--font-ui)"
  }, d.m)));
}
Object.assign(__ds_scope, { AreaChart });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/metrics/AreaChart.jsx", error: String((e && e.message) || e) }); }

// components/metrics/MetricTile.jsx
try { (() => {
/**
 * MetricTile — a single dashboard KPI: uppercase label (optional icon), a large
 * tabular-numeric value, and an optional delta chip + sub caption. Compose
 * several side-by-side inside a `.stat-row` or `.grid-*`.
 */
function MetricTile({
  label,
  icon,
  value,
  delta,
  deltaDir = 'up',
  sub
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "stat"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-label"
  }, icon && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon
  }), label), /*#__PURE__*/React.createElement("div", {
    className: "stat-value"
  }, value), (delta != null || sub) && /*#__PURE__*/React.createElement("div", {
    className: "stat-sub"
  }, delta != null && /*#__PURE__*/React.createElement("span", {
    className: `stat-delta ${deltaDir}`
  }, deltaDir === 'up' && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "trend_up"
  }), deltaDir === 'down' && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "trend_down"
  }), delta), sub && /*#__PURE__*/React.createElement("span", null, sub)));
}
Object.assign(__ds_scope, { MetricTile });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/metrics/MetricTile.jsx", error: String((e && e.message) || e) }); }

// components/metrics/MetricsFilterBar.jsx
try { (() => {
const PRESETS = [['this-month', 'This month'], ['last-month', 'Last month'], ['this-quarter', 'This quarter'], ['ytd', 'Year to date'], ['last-12', 'Last 12 months'], ['all', 'All time']];
const LENSES = [['booked', 'Booked'], ['scheduled', 'Scheduled'], ['paid', 'Paid']];
const SOURCES = [['all', 'All'], ['exclude', 'Native only'], ['only', 'CC only']];

/**
 * MetricsFilterBar — the financials/dashboard filter row: a date-range select,
 * a source segmented toggle, and a money-lens segmented toggle. Controlled via
 * the `filter` object (preset, includeCc, basis + setters).
 */
function MetricsFilterBar({
  filter = {}
}) {
  const {
    basis = 'booked',
    includeCc = 'all',
    activePreset = 'this-month',
    setPreset = () => {},
    setBasis = () => {},
    setIncludeCc = () => {}
  } = filter;
  return /*#__PURE__*/React.createElement("div", {
    className: "hstack",
    style: {
      gap: 12,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: activePreset,
    onChange: e => setPreset(e.target.value),
    "aria-label": "Date range"
  }, PRESETS.map(([v, l]) => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, l))), /*#__PURE__*/React.createElement("div", {
    className: "metrics-seg",
    role: "group",
    "aria-label": "Source filter",
    style: {
      marginLeft: 'auto'
    }
  }, SOURCES.map(([v, l]) => /*#__PURE__*/React.createElement("button", {
    key: v,
    type: "button",
    className: `metrics-seg-btn${includeCc === v ? ' is-active' : ''}`,
    "aria-pressed": includeCc === v,
    onClick: () => setIncludeCc(v)
  }, l))), /*#__PURE__*/React.createElement("div", {
    className: "metrics-seg",
    role: "group",
    "aria-label": "Money lens"
  }, LENSES.map(([v, l]) => /*#__PURE__*/React.createElement("button", {
    key: v,
    type: "button",
    className: `metrics-seg-btn${basis === v ? ' is-active' : ''}`,
    "aria-pressed": basis === v,
    onClick: () => setBasis(v)
  }, l))));
}
Object.assign(__ds_scope, { MetricsFilterBar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/metrics/MetricsFilterBar.jsx", error: String((e && e.message) || e) }); }

// components/metrics/Sparkline.jsx
try { (() => {
/**
 * Sparkline — tiny inline trend line. Scales to its data; stroke defaults to
 * the current accent. Purely decorative (no axes).
 */
function Sparkline({
  data = [],
  stroke = 'var(--accent)',
  width = 120,
  height = 30
}) {
  if (!data.length) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const pts = data.map((v, i) => [i * (width / (data.length - 1 || 1)), height - (v - min) / (max - min || 1) * (height - 4) - 2]);
  const d = pts.reduce((s, [x, y], i) => s + (i ? ` L ${x} ${y}` : `M ${x} ${y}`), '');
  return /*#__PURE__*/React.createElement("svg", {
    className: "spark",
    width: width,
    height: height,
    style: {
      display: 'block'
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: d,
    fill: "none",
    stroke: stroke,
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }));
}
Object.assign(__ds_scope, { Sparkline });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/metrics/Sparkline.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Header.jsx
try { (() => {
/**
 * Header — the top app bar: page title, a ⌘K command-palette search trigger,
 * and quick actions (notifications + create). Sits in the shell's header area.
 */
function Header({
  title = 'Dashboard',
  onOpenPalette = () => {},
  onQuickAdd = () => {},
  unread = 0
}) {
  return /*#__PURE__*/React.createElement("header", {
    className: "header"
  }, /*#__PURE__*/React.createElement("div", {
    className: "header-title"
  }, title), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "header-search",
    onClick: onOpenPalette,
    "aria-label": "Open command palette"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "search"
  }), /*#__PURE__*/React.createElement("span", null, "Search events, clients, proposals\u2026"), /*#__PURE__*/React.createElement("span", {
    className: "kbd-group"
  }, /*#__PURE__*/React.createElement("span", {
    className: "kbd"
  }, "\u2318"), /*#__PURE__*/React.createElement("span", {
    className: "kbd"
  }, "K"))), /*#__PURE__*/React.createElement("div", {
    className: "header-actions"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "icon-btn",
    title: "Notifications",
    "aria-label": "Notifications"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "bell"
  }), unread > 0 && /*#__PURE__*/React.createElement("span", {
    className: "dot"
  })), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "icon-btn",
    title: "New proposal",
    "aria-label": "Quick create",
    onClick: onQuickAdd
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "plus"
  }))));
}
Object.assign(__ds_scope, { Header });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Header.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Sidebar.jsx
try { (() => {
const {
  useState
} = React;
const DEFAULT_NAV = [{
  section: 'Workspace',
  items: [{
    id: 'dashboard',
    label: 'Dashboard',
    icon: 'home',
    path: '/dashboard'
  }, {
    id: 'events',
    label: 'Events',
    icon: 'calendar',
    path: '/events',
    badge: 3
  }, {
    id: 'proposals',
    label: 'Proposals',
    icon: 'clipboard',
    path: '/proposals',
    badge: 5
  }, {
    id: 'clients',
    label: 'Clients',
    icon: 'users',
    path: '/clients'
  }, {
    id: 'messages',
    label: 'Messages',
    icon: 'chat',
    path: '/messages',
    badge: 2,
    badgeTone: 'danger'
  }, {
    id: 'staff',
    label: 'Staff',
    icon: 'userplus',
    path: '/staffing'
  }, {
    id: 'hiring',
    label: 'Hiring',
    icon: 'pen',
    path: '/hiring'
  }]
}, {
  section: 'Revenue',
  items: [{
    id: 'financials',
    label: 'Financials',
    icon: 'dollar',
    path: '/financials'
  }, {
    id: 'tips',
    label: 'Tips & Feedback',
    icon: 'dollar',
    path: '/tips'
  }, {
    id: 'marketing',
    label: 'Marketing',
    icon: 'mail',
    path: '/email-marketing'
  }]
}, {
  section: 'Content',
  items: [{
    id: 'drink-plans',
    label: 'Drink Plans',
    icon: 'flask',
    path: '/drink-plans',
    badge: 1,
    badgeTone: 'warn'
  }, {
    id: 'menu',
    label: 'Cocktail Menu',
    icon: 'book',
    path: '/cocktail-menu'
  }, {
    id: 'blog',
    label: 'Lab Notes',
    icon: 'pen',
    path: '/blog'
  }, {
    id: 'settings',
    label: 'Settings',
    icon: 'gear',
    path: '/settings'
  }]
}];
function initialsOf(user) {
  const src = user?.name || user?.email || '?';
  return src.split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

/**
 * Sidebar — the collapsible rail navigation. Renders sectioned nav with badge
 * counts, a controls footer (rail collapse, House Lights/After Hours skin
 * toggle, Comfy/Compact density toggle) and a user footer. In rail mode labels
 * collapse to icons with a hover tooltip.
 *
 * `prefs` = { sidebar: 'full'|'rail', skin: 'dark'|'light', density: 'comfy'|'compact' }.
 * `onPref(key, value)` is called when a control changes.
 */
function Sidebar({
  nav = DEFAULT_NAV,
  activePath = '/dashboard',
  onNavigate = () => {},
  prefs = {
    sidebar: 'full',
    skin: 'dark',
    density: 'comfy'
  },
  onPref = () => {},
  user = {
    name: 'Ada Quinn',
    role: 'Admin'
  }
}) {
  const rail = prefs.sidebar === 'rail';
  const [tip, setTip] = useState(null);
  const isActive = p => activePath === p || activePath.startsWith(p + '/');
  return /*#__PURE__*/React.createElement("aside", {
    className: "sidebar",
    "aria-label": "Primary navigation"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sidebar-brand"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sidebar-brand-mark"
  }, "\u211E"), /*#__PURE__*/React.createElement("div", {
    className: "sidebar-brand-text"
  }, "Dr. Bartender ", /*#__PURE__*/React.createElement("span", {
    className: "muted"
  }, "OS"))), /*#__PURE__*/React.createElement("nav", {
    className: "sidebar-nav scroll-thin"
  }, nav.map(group => /*#__PURE__*/React.createElement(React.Fragment, {
    key: group.section
  }, /*#__PURE__*/React.createElement("div", {
    className: "sidebar-section"
  }, group.section), group.items.map(item => /*#__PURE__*/React.createElement("div", {
    key: item.id,
    className: `nav-item ${isActive(item.path) ? 'active' : ''}`,
    role: "button",
    tabIndex: 0,
    onClick: () => onNavigate(item.path),
    onMouseEnter: e => rail && setTip({
      label: item.label,
      top: e.currentTarget.getBoundingClientRect().top + 15
    }),
    onMouseLeave: () => setTip(null),
    title: rail ? item.label : undefined
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: item.icon
  }), /*#__PURE__*/React.createElement("span", {
    className: "nav-label"
  }, item.label), item.badge > 0 && /*#__PURE__*/React.createElement("span", {
    className: `nav-badge ${item.badgeTone || ''}`
  }, item.badge)))))), /*#__PURE__*/React.createElement("div", {
    className: "sidebar-footer sidebar-footer-controls"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "sidebar-footer-action",
    title: rail ? 'Expand sidebar' : 'Collapse to rail',
    onClick: () => onPref('sidebar', rail ? 'full' : 'rail')
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: rail ? 'right' : 'left',
    size: 13
  })), /*#__PURE__*/React.createElement("div", {
    className: "mode-toggle",
    role: "radiogroup",
    "aria-label": "Visual mode"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    role: "radio",
    "aria-checked": prefs.skin === 'light',
    className: `mode-opt ${prefs.skin === 'light' ? 'active' : ''}`,
    onClick: () => onPref('skin', 'light')
  }, "House Lights"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    role: "radio",
    "aria-checked": prefs.skin === 'dark',
    className: `mode-opt ${prefs.skin === 'dark' ? 'active' : ''}`,
    onClick: () => onPref('skin', 'dark')
  }, "After Hours")), /*#__PURE__*/React.createElement("div", {
    className: "mode-toggle",
    role: "radiogroup",
    "aria-label": "Density"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    role: "radio",
    "aria-checked": prefs.density === 'comfy',
    className: `mode-opt ${prefs.density === 'comfy' ? 'active' : ''}`,
    onClick: () => onPref('density', 'comfy')
  }, "Comfy"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    role: "radio",
    "aria-checked": prefs.density === 'compact',
    className: `mode-opt ${prefs.density === 'compact' ? 'active' : ''}`,
    onClick: () => onPref('density', 'compact')
  }, "Compact"))), /*#__PURE__*/React.createElement("div", {
    className: "sidebar-footer sidebar-footer--user"
  }, /*#__PURE__*/React.createElement("div", {
    className: "avatar"
  }, initialsOf(user)), /*#__PURE__*/React.createElement("div", {
    className: "sidebar-footer-main"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sidebar-footer-name"
  }, user?.name), /*#__PURE__*/React.createElement("div", {
    className: "sidebar-footer-role"
  }, user?.role, " \xB7 Dr. Bartender")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "sidebar-footer-action",
    title: "Sign out"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "logout",
    size: 13
  }))), tip && !rail === false && /*#__PURE__*/React.createElement("div", {
    className: "nav-rail-tip",
    style: {
      top: tip.top
    }
  }, tip.label));
}
Object.assign(__ds_scope, { DEFAULT_NAV, Sidebar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Sidebar.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Toolbar.jsx
try { (() => {
/**
 * Toolbar — the shared list-page control row: optional segmented tabs, a search
 * input, an optional filter slot, and a right-aligned action slot.
 */
function Toolbar({
  search,
  setSearch,
  tabs,
  tab,
  setTab,
  filters,
  right
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "hstack",
    style: {
      gap: 8,
      flexWrap: 'wrap'
    }
  }, tabs && /*#__PURE__*/React.createElement("div", {
    className: "seg"
  }, tabs.map(t => /*#__PURE__*/React.createElement("button", {
    key: t.id,
    type: "button",
    className: tab === t.id ? 'active' : '',
    onClick: () => setTab && setTab(t.id)
  }, t.label, t.count != null && /*#__PURE__*/React.createElement("span", {
    className: "muted",
    style: {
      marginLeft: 6
    }
  }, t.count)))), setSearch && /*#__PURE__*/React.createElement("div", {
    className: "input-group",
    style: {
      minWidth: 240,
      maxWidth: 340,
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "search"
  }), /*#__PURE__*/React.createElement("input", {
    placeholder: "Search\u2026",
    value: search || '',
    onChange: e => setSearch(e.target.value),
    "aria-label": "Search"
  })), filters, /*#__PURE__*/React.createElement("div", {
    className: "spacer"
  }), right);
}
Object.assign(__ds_scope, { Toolbar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Toolbar.jsx", error: String((e && e.message) || e) }); }

// components/overlay/DocumentPreviewModal.jsx
try { (() => {
const {
  useEffect
} = React;
/**
 * DocumentPreviewModal — centered modal that previews an uploaded document
 * (image or PDF/iframe) with a title, download + close actions. Skin-aware
 * surfaces so it reads in both House Lights and After Hours.
 */
function DocumentPreviewModal({
  open,
  onClose = () => {},
  title = 'Document',
  src,
  kind = 'image',
  onDownload
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = e => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return /*#__PURE__*/React.createElement("div", {
    className: "palette-scrim open",
    onClick: onClose,
    role: "dialog",
    "aria-modal": "true",
    "aria-label": title,
    style: {
      alignItems: 'center',
      paddingTop: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card",
    onClick: e => e.stopPropagation(),
    style: {
      width: 'min(560px, 92%)',
      maxHeight: '86%',
      display: 'flex',
      flexDirection: 'column'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-head"
  }, /*#__PURE__*/React.createElement("h3", {
    style: {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, title), /*#__PURE__*/React.createElement("div", {
    className: "hstack",
    style: {
      gap: 6
    }
  }, onDownload && /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "btn btn-secondary btn-sm",
    onClick: onDownload
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "arrow_right",
    size: 12
  }), "Download"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "icon-btn",
    onClick: onClose,
    "aria-label": "Close"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "x",
    size: 14
  })))), /*#__PURE__*/React.createElement("div", {
    className: "card-body",
    style: {
      overflow: 'auto',
      background: 'var(--bg-0)',
      display: 'grid',
      placeItems: 'center',
      flex: 1
    }
  }, kind === 'image' ? /*#__PURE__*/React.createElement("img", {
    src: src,
    alt: title,
    style: {
      maxWidth: '100%',
      maxHeight: '60vh',
      display: 'block',
      borderRadius: 6
    }
  }) : /*#__PURE__*/React.createElement("iframe", {
    title: title,
    src: src,
    style: {
      width: '100%',
      height: '60vh',
      border: 0,
      background: 'var(--bg-1)'
    }
  }))));
}
Object.assign(__ds_scope, { DocumentPreviewModal });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/overlay/DocumentPreviewModal.jsx", error: String((e && e.message) || e) }); }

// components/overlay/Drawer.jsx
try { (() => {
const {
  useEffect
} = React;
/**
 * Drawer — the right-side detail panel that slides over a list page. Renders a
 * scrim + panel with a breadcrumb head, an optional "Open page" link, a close
 * button, a scrollable body and an optional sticky footer. Positioned inside
 * the nearest positioned ancestor (the shell) rather than the viewport.
 */
function Drawer({
  open,
  onClose = () => {},
  crumb,
  children,
  onOpenPage,
  footer
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = e => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: `drawer-scrim ${open ? 'open' : ''}`,
    onClick: onClose,
    "aria-hidden": !open
  }), /*#__PURE__*/React.createElement("div", {
    className: `drawer ${open ? 'open' : ''}`,
    role: "dialog",
    "aria-modal": open ? 'true' : 'false',
    "aria-hidden": !open
  }, /*#__PURE__*/React.createElement("div", {
    className: "drawer-head"
  }, /*#__PURE__*/React.createElement("div", {
    className: "crumb"
  }, crumb), onOpenPage && /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "btn btn-ghost btn-sm",
    onClick: onOpenPage
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "external",
    size: 11
  }), "Open page"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "icon-btn",
    onClick: onClose,
    "aria-label": "Close drawer"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "x",
    size: 14
  }))), /*#__PURE__*/React.createElement("div", {
    className: "drawer-body scroll-thin"
  }, children), footer));
}
Object.assign(__ds_scope, { Drawer });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/overlay/Drawer.jsx", error: String((e && e.message) || e) }); }

// components/staff/NextEventCard.jsx
try { (() => {
/**
 * NextEventCard — the staff Home hero: the upcoming shift with a relative-date
 * pill, venue, time/role/pay meta, and a confirm/details footer. Left accent
 * bar reflects state (confirmed / needs-action).
 */
function NextEventCard({
  shift = {},
  onConfirm,
  onDetails = () => {}
}) {
  const state = shift.state || 'needs-action';
  return /*#__PURE__*/React.createElement("div", {
    className: `sp-shift ${state}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "sp-shift-head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sp-shift-when"
  }, shift.when || 'Sat · Jun 14'), /*#__PURE__*/React.createElement("span", {
    className: `sp-shift-rel ${shift.today ? 'today' : ''}`
  }, shift.rel || 'In 3d')), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "sp-shift-name"
  }, shift.name || 'Vantage Rooftop'), /*#__PURE__*/React.createElement("div", {
    className: "sp-shift-type"
  }, shift.type || 'Private event · Lead bartender')), /*#__PURE__*/React.createElement("div", {
    className: "sp-shift-meta"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sp-shift-meta-row"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "clock",
    size: 13
  }), shift.time || '6:00 – 11:00 PM'), /*#__PURE__*/React.createElement("span", {
    className: "sp-shift-meta-row"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "location",
    size: 13
  }), shift.venue || 'Downtown')), /*#__PURE__*/React.createElement("div", {
    className: "sp-shift-foot"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sp-shift-foot-l"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sp-shift-payout"
  }, shift.pay || '$220'), /*#__PURE__*/React.createElement("span", {
    className: "sp-mono",
    style: {
      fontSize: 11,
      color: 'var(--sp-ink-3)'
    }
  }, "est. payout")), /*#__PURE__*/React.createElement("div", {
    className: "hstack",
    style: {
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "sp-btn sp-btn-secondary",
    style: {
      height: 32,
      fontSize: 12.5
    },
    onClick: onDetails
  }, "Details"), state === 'needs-action' && onConfirm && /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "sp-btn sp-btn-primary",
    style: {
      height: 32,
      fontSize: 12.5
    },
    onClick: onConfirm
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "check",
    size: 14
  }), "Confirm"))));
}
Object.assign(__ds_scope, { NextEventCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/staff/NextEventCard.jsx", error: String((e && e.message) || e) }); }

// components/staff/PayoutRow.jsx
try { (() => {
/**
 * PayoutRow — a single line in the Pay tab: pay-period label + status chip on
 * the left, amount on the right. Compose several under a section heading.
 */
function PayoutRow({
  label,
  period,
  amount,
  status,
  statusKind = 'ok',
  onClick = () => {}
}) {
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "sp-earnings",
    onClick: onClick,
    style: {
      cursor: 'pointer',
      textAlign: 'left',
      width: '100%'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "sp-earnings-k",
    style: {
      letterSpacing: '0.06em'
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: 'var(--sp-ink-3)',
      marginTop: 3
    }
  }, period)), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'right'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "sp-earnings-v",
    style: {
      fontSize: 20
    }
  }, amount), status && /*#__PURE__*/React.createElement("span", {
    className: `sp-chip ${statusKind}`,
    style: {
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "sp-chip-dot"
  }), status)));
}
Object.assign(__ds_scope, { PayoutRow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/staff/PayoutRow.jsx", error: String((e && e.message) || e) }); }

// components/staff/ShiftRow.jsx
try { (() => {
/**
 * ShiftRow — a compact upcoming/past shift entry for the Shifts tab. Left
 * accent bar reflects state; shows date, venue, role/time and payout.
 */
function ShiftRow({
  shift = {},
  onClick = () => {}
}) {
  const state = shift.state || '';
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `sp-shift ${state}`,
    onClick: onClick,
    style: {
      cursor: 'pointer',
      textAlign: 'left',
      width: '100%'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "sp-shift-head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sp-shift-when"
  }, shift.when), shift.rel && /*#__PURE__*/React.createElement("span", {
    className: `sp-shift-rel ${shift.today ? 'today' : ''}`
  }, shift.rel)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "sp-shift-name",
    style: {
      fontSize: 15
    }
  }, shift.name), /*#__PURE__*/React.createElement("div", {
    className: "sp-shift-type"
  }, shift.type)), /*#__PURE__*/React.createElement("div", {
    className: "sp-shift-foot"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sp-shift-foot-l"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sp-shift-meta-row",
    style: {
      fontSize: 12,
      color: 'var(--sp-ink-2)'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "clock",
    size: 13
  }), shift.time)), /*#__PURE__*/React.createElement("span", {
    className: "sp-shift-payout",
    style: {
      fontSize: 14
    }
  }, shift.pay)));
}
Object.assign(__ds_scope, { ShiftRow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/staff/ShiftRow.jsx", error: String((e && e.message) || e) }); }

// components/staff/StaffTabBar.jsx
try { (() => {
const STAFF_TABS = [{
  id: 'home',
  label: 'Home',
  icon: 'home'
}, {
  id: 'shifts',
  label: 'Shifts',
  icon: 'calendar'
}, {
  id: 'pay',
  label: 'Pay',
  icon: 'dollar'
}, {
  id: 'tipcard',
  label: 'Tip Card',
  icon: 'card'
}];

/**
 * StaffTabBar — the mobile portal tab navigation (Home / Shifts / Pay / Tip
 * Card). Defaults to a bottom bar; pass `position="top"` for the sticky top
 * variant. Optional per-tab unread badges.
 */
function StaffTabBar({
  tabs = STAFF_TABS,
  active,
  onChange = () => {},
  badges = {},
  position = 'bottom'
}) {
  return /*#__PURE__*/React.createElement("nav", {
    className: `sp-tabs ${position === 'top' ? 'top' : ''}`,
    "aria-label": "Staff portal sections"
  }, tabs.map(t => {
    const isActive = active === t.id;
    const badge = badges[t.id];
    return /*#__PURE__*/React.createElement("button", {
      key: t.id,
      type: "button",
      className: `sp-tab ${isActive ? 'active' : ''}`,
      onClick: () => onChange(t.id),
      "aria-current": isActive ? 'page' : undefined
    }, badge > 0 && /*#__PURE__*/React.createElement("span", {
      className: "sp-tab-badge"
    }, badge), /*#__PURE__*/React.createElement(__ds_scope.Icon, {
      name: t.icon,
      size: 18
    }), /*#__PURE__*/React.createElement("span", null, t.label));
  }));
}
Object.assign(__ds_scope, { STAFF_TABS, StaffTabBar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/staff/StaffTabBar.jsx", error: String((e && e.message) || e) }); }

// components/staff/StaffUserPillMenu.jsx
try { (() => {
const {
  useEffect
} = React;
/**
 * StaffUserPillMenu — the popover opened by the topbar user pill. Shows the
 * user's name/email, a House Lights / After Hours lighting toggle, and a list
 * of menu actions (each with an icon and optional danger tone).
 */
function StaffUserPillMenu({
  user = {},
  skin = 'dark',
  onSkinChange = () => {},
  items = [],
  onClose = () => {}
}) {
  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return /*#__PURE__*/React.createElement("div", {
    className: "sp-menu",
    role: "menu"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sp-menu-head"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sp-avatar",
    style: {
      width: 32,
      height: 32,
      fontSize: 12
    }
  }, user.initials), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "sp-menu-head-name"
  }, user.name), /*#__PURE__*/React.createElement("div", {
    className: "sp-menu-head-sub"
  }, user.email))), /*#__PURE__*/React.createElement("div", {
    className: "sp-menu-list"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sp-menu-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sp-menu-section-k"
  }, "Lighting"), /*#__PURE__*/React.createElement("div", {
    className: "sp-skin-seg",
    role: "group",
    "aria-label": "Lighting"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `sp-skin-seg-btn ${skin === 'light' ? 'active' : ''}`,
    onClick: () => onSkinChange('light'),
    "aria-pressed": skin === 'light'
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "sun",
    size: 13
  }), "House lights"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `sp-skin-seg-btn ${skin === 'dark' ? 'active' : ''}`,
    onClick: () => onSkinChange('dark'),
    "aria-pressed": skin === 'dark'
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "moon",
    size: 13
  }), "After hours"))), items.map(it => /*#__PURE__*/React.createElement("button", {
    key: it.id,
    type: "button",
    role: "menuitem",
    className: `sp-menu-item ${it.tone || ''}`,
    onClick: () => {
      onClose();
      it.onClick?.();
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: it.icon,
    size: 14
  }), /*#__PURE__*/React.createElement("span", null, it.label)))));
}
Object.assign(__ds_scope, { StaffUserPillMenu });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/staff/StaffUserPillMenu.jsx", error: String((e && e.message) || e) }); }

// components/status/StaffPills.jsx
try { (() => {
/**
 * StaffPills — per-position fill indicator for an event's roster. Each pill is
 * filled (approved / green), pending (amber) or open (neutral). Trailing count
 * shows filled/total and how many are still open.
 */
function StaffPills({
  positions = []
}) {
  const filled = positions.filter(p => p.status === 'approved').length;
  const pending = positions.filter(p => p.status === 'pending').length;
  const total = positions.length;
  const shortBy = total - filled - pending;
  return /*#__PURE__*/React.createElement("span", {
    className: "hstack",
    style: {
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "staff-pills"
  }, positions.map((p, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    className: `staff-pill ${p.status === 'approved' ? 'filled' : p.status === 'pending' ? 'pending' : ''}`,
    title: `${p.role}${p.name ? ': ' + p.name : ' (open)'}`
  }))), /*#__PURE__*/React.createElement("span", {
    className: `staff-count ${shortBy > 0 ? 'short' : ''}`
  }, filled, "/", total, shortBy > 0 && ` · ${shortBy} open`));
}
Object.assign(__ds_scope, { StaffPills });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/status/StaffPills.jsx", error: String((e && e.message) || e) }); }

// components/status/StatusChip.jsx
try { (() => {
/**
 * StatusChip — OS-native status pill driven by the semantic rainbow hues
 * (ok / warn / danger / info / violet / accent / neutral). Do NOT use the
 * apothecary parchment badges here.
 */
function StatusChip({
  kind = 'neutral',
  children,
  dot = true
}) {
  return /*#__PURE__*/React.createElement("span", {
    className: `chip ${kind}`
  }, dot && /*#__PURE__*/React.createElement("span", {
    className: "chip-dot"
  }), children);
}
Object.assign(__ds_scope, { StatusChip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/status/StatusChip.jsx", error: String((e && e.message) || e) }); }

// components/table/DataTableRow.jsx
try { (() => {
/**
 * DataTableRow — one row of the OS workhorse `.tbl`. Pass an array of cells;
 * each is `{ content, className?, primary?, sub? }`. A `primary` cell renders
 * bold with an optional muted sub-line. Use inside `<table className="tbl">`.
 * `selected` tints the row with the accent-active wash.
 */
function DataTableRow({
  cells = [],
  selected = false,
  onClick
}) {
  return /*#__PURE__*/React.createElement("tr", {
    className: selected ? 'selected' : '',
    onClick: onClick
  }, cells.map((c, i) => /*#__PURE__*/React.createElement("td", {
    key: i,
    className: [c.className, c.num ? 'num' : '', c.muted ? 'muted' : ''].filter(Boolean).join(' ')
  }, c.primary ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("strong", null, c.content), c.sub && /*#__PURE__*/React.createElement("div", {
    className: "sub"
  }, c.sub)) : c.content)));
}
Object.assign(__ds_scope, { DataTableRow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/table/DataTableRow.jsx", error: String((e && e.message) || e) }); }

// ui_kits/admin/screens.jsx
try { (() => {
/* Admin OS UI kit — screen bodies. Composes design-system components off
   window.DrBartenderOSDesignSystem_720350. Loaded after the bundle + Babel. */
const DS = window.DrBartenderOSDesignSystem_720350;
const {
  MetricTile,
  Sparkline,
  AreaChart,
  MetricsFilterBar,
  DataTableRow,
  StatusChip,
  StaffPills,
  KebabMenu,
  Icon,
  Drawer
} = DS;
const REV = [{
  m: 'Jul',
  booked: 82,
  collected: 71
}, {
  m: 'Aug',
  booked: 96,
  collected: 88
}, {
  m: 'Sep',
  booked: 74,
  collected: 79
}, {
  m: 'Oct',
  booked: 118,
  collected: 96
}, {
  m: 'Nov',
  booked: 134,
  collected: 121
}, {
  m: 'Dec',
  booked: 156,
  collected: 140
}, {
  m: 'Jan',
  booked: 92,
  collected: 101
}, {
  m: 'Feb',
  booked: 128,
  collected: 110
}];
const EVENTS = [{
  id: 1,
  name: 'Vantage Rooftop',
  client: 'Kestrel Events',
  date: 'Sat, Jun 14',
  guests: 140,
  total: '$4,200',
  status: ['ok', 'Confirmed'],
  staff: [3, 0, 0],
  priv: true
}, {
  id: 2,
  name: 'Harbor Loft',
  client: 'Vale & Co.',
  date: 'Sun, Jun 22',
  guests: 90,
  total: '$3,150',
  status: ['warn', 'Needs staff'],
  staff: [2, 1, 1]
}, {
  id: 3,
  name: 'Gallery 9 Opening',
  client: 'Novo Group',
  date: 'Fri, Jul 4',
  guests: 220,
  total: '$5,600',
  status: ['info', 'Scheduled'],
  staff: [0, 0, 4]
}, {
  id: 4,
  name: 'Meridian Gala',
  client: 'Meridian',
  date: 'Sat, Jul 12',
  guests: 60,
  total: '$2,900',
  status: ['danger', 'Deposit overdue'],
  staff: [4, 0, 0],
  priv: true
}, {
  id: 5,
  name: 'Summit After-Party',
  client: 'Arclight',
  date: 'Thu, Jul 18',
  guests: 300,
  total: '$8,400',
  status: ['violet', 'VIP'],
  staff: [5, 1, 2]
}];
const ROW_MENU = [{
  label: 'View details',
  icon: 'eye'
}, {
  label: 'Assign staff',
  icon: 'userplus'
}, {
  label: 'Email client',
  icon: 'mail',
  href: 'mailto:x@y.com'
}, {
  label: 'Cancel event',
  icon: 'x',
  danger: true
}];
const pills = ([a, p, o]) => /*#__PURE__*/React.createElement(StaffPills, {
  positions: [...Array(a).fill({
    role: 'x',
    status: 'approved'
  }), ...Array(p).fill({
    role: 'x',
    status: 'pending'
  }), ...Array(o).fill({
    role: 'x',
    status: 'open'
  })]
});
function Dashboard() {
  const [filter] = React.useState({
    basis: 'booked',
    includeCc: 'all',
    activePreset: 'last-12',
    setPreset() {},
    setBasis() {},
    setIncludeCc() {}
  });
  return /*#__PURE__*/React.createElement("div", {
    className: "page"
  }, /*#__PURE__*/React.createElement("div", {
    className: "page-header"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "page-title"
  }, "Dashboard"), /*#__PURE__*/React.createElement("div", {
    className: "page-subtitle"
  }, "Tuesday, June 10 \xB7 3 items need attention")), /*#__PURE__*/React.createElement("div", {
    className: "page-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-secondary"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 12
  }), "Reports"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "plus",
    size: 12
  }), "New proposal"))), /*#__PURE__*/React.createElement("div", {
    className: "stat-row"
  }, /*#__PURE__*/React.createElement(MetricTile, {
    label: "Booked (MTD)",
    icon: "dollar",
    value: "$128k",
    delta: "+18%",
    deltaDir: "up",
    sub: "vs May"
  }), /*#__PURE__*/React.createElement(MetricTile, {
    label: "Collected",
    icon: "check",
    value: "$110k",
    delta: "+9%",
    deltaDir: "up"
  }), /*#__PURE__*/React.createElement(MetricTile, {
    label: "Events",
    icon: "calendar",
    value: "24",
    delta: "+4",
    deltaDir: "up"
  }), /*#__PURE__*/React.createElement(MetricTile, {
    label: "Unpaid",
    icon: "alert",
    value: "$8,400",
    delta: "-12%",
    deltaDir: "down"
  }), /*#__PURE__*/React.createElement(MetricTile, {
    label: "Fill rate",
    icon: "userplus",
    value: "94%",
    delta: "0",
    deltaDir: "flat",
    sub: /*#__PURE__*/React.createElement(Sparkline, {
      data: [6, 5, 7, 8, 7, 9, 8]
    })
  })), /*#__PURE__*/React.createElement("div", {
    className: "dash-main"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-head"
  }, /*#__PURE__*/React.createElement("h3", null, "Revenue"), /*#__PURE__*/React.createElement(MetricsFilterBar, {
    filter: filter
  })), /*#__PURE__*/React.createElement("div", {
    className: "card-body"
  }, /*#__PURE__*/React.createElement(AreaChart, {
    data: REV,
    keys: ['booked', 'collected']
  }))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-head"
  }, /*#__PURE__*/React.createElement("h3", null, "Needs you"), /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, "3")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "queue-item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "queue-icon danger"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "dollar"
  })), /*#__PURE__*/React.createElement("div", {
    className: "queue-main"
  }, /*#__PURE__*/React.createElement("div", {
    className: "queue-title"
  }, "Deposit overdue"), /*#__PURE__*/React.createElement("div", {
    className: "queue-sub"
  }, "Meridian Gala \xB7 4 days")), /*#__PURE__*/React.createElement("span", {
    className: "queue-meta"
  }, "$1,450")), /*#__PURE__*/React.createElement("div", {
    className: "queue-item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "queue-icon warn"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "userplus"
  })), /*#__PURE__*/React.createElement("div", {
    className: "queue-main"
  }, /*#__PURE__*/React.createElement("div", {
    className: "queue-title"
  }, "Harbor Loft short-staffed"), /*#__PURE__*/React.createElement("div", {
    className: "queue-sub"
  }, "2 of 4 roles open")), /*#__PURE__*/React.createElement(Icon, {
    name: "right"
  })), /*#__PURE__*/React.createElement("div", {
    className: "queue-item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "queue-icon info"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "clipboard"
  })), /*#__PURE__*/React.createElement("div", {
    className: "queue-main"
  }, /*#__PURE__*/React.createElement("div", {
    className: "queue-title"
  }, "Proposal awaiting review"), /*#__PURE__*/React.createElement("div", {
    className: "queue-sub"
  }, "Novo Group \xB7 sent 2d ago")), /*#__PURE__*/React.createElement(Icon, {
    name: "right"
  }))))));
}
function Events({
  onOpen
}) {
  const [tab, setTab] = React.useState('all');
  return /*#__PURE__*/React.createElement("div", {
    className: "page"
  }, /*#__PURE__*/React.createElement("div", {
    className: "page-header"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "page-title"
  }, "Events"), /*#__PURE__*/React.createElement("div", {
    className: "page-subtitle"
  }, "24 upcoming \xB7 3 need staffing")), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "plus",
    size: 12
  }), "New event")), /*#__PURE__*/React.createElement("div", {
    className: "hstack",
    style: {
      gap: 8,
      flexWrap: 'wrap',
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "seg"
  }, [['all', 'All', 24], ['wk', 'This week', 4], ['unstaffed', 'Unstaffed', 3]].map(([id, l, c]) => /*#__PURE__*/React.createElement("button", {
    key: id,
    className: tab === id ? 'active' : '',
    onClick: () => setTab(id)
  }, l, /*#__PURE__*/React.createElement("span", {
    className: "muted",
    style: {
      marginLeft: 6
    }
  }, c)))), /*#__PURE__*/React.createElement("div", {
    className: "input-group",
    style: {
      minWidth: 220,
      flex: 1,
      maxWidth: 320
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "search"
  }), /*#__PURE__*/React.createElement("input", {
    placeholder: "Search events\u2026"
  })), /*#__PURE__*/React.createElement("div", {
    className: "spacer"
  }), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-secondary"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "filter",
    size: 12
  }), "Filter")), /*#__PURE__*/React.createElement("div", {
    className: "tbl-wrap"
  }, /*#__PURE__*/React.createElement("table", {
    className: "tbl"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Event"), /*#__PURE__*/React.createElement("th", null, "Date"), /*#__PURE__*/React.createElement("th", null, "Status"), /*#__PURE__*/React.createElement("th", null, "Staffing"), /*#__PURE__*/React.createElement("th", {
    className: "num"
  }, "Total"), /*#__PURE__*/React.createElement("th", {
    className: "shrink"
  }))), /*#__PURE__*/React.createElement("tbody", null, EVENTS.map(e => /*#__PURE__*/React.createElement(DataTableRow, {
    key: e.id,
    onClick: () => onOpen(e),
    cells: [{
      content: /*#__PURE__*/React.createElement(React.Fragment, null, e.name, e.priv && /*#__PURE__*/React.createElement("span", {
        className: "tag",
        style: {
          marginLeft: 6
        }
      }, "Private")),
      primary: true,
      sub: e.client
    }, {
      content: e.date,
      muted: true
    }, {
      content: /*#__PURE__*/React.createElement(StatusChip, {
        kind: e.status[0]
      }, e.status[1])
    }, {
      content: pills(e.staff)
    }, {
      content: e.total,
      num: true
    }, {
      content: /*#__PURE__*/React.createElement(KebabMenu, {
        items: ROW_MENU
      })
    }]
  }))))));
}
function Financials() {
  const [filter, setF] = React.useState({
    basis: 'booked',
    includeCc: 'all',
    activePreset: 'last-12'
  });
  const set = k => v => setF(f => ({
    ...f,
    [k]: v
  }));
  const fw = {
    ...filter,
    setPreset: set('activePreset'),
    setBasis: set('basis'),
    setIncludeCc: set('includeCc')
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "page"
  }, /*#__PURE__*/React.createElement("div", {
    className: "page-header"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "page-title"
  }, "Financials"), /*#__PURE__*/React.createElement("div", {
    className: "page-subtitle"
  }, "Last 12 months \xB7 booked basis")), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-secondary"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "external",
    size: 12
  }), "Export CSV")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement(MetricsFilterBar, {
    filter: fw
  })), /*#__PURE__*/React.createElement("div", {
    className: "grid-3",
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-label"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "dollar"
  }), "Gross booked"), /*#__PURE__*/React.createElement("div", {
    className: "stat-value"
  }, "$1.24M"), /*#__PURE__*/React.createElement("div", {
    className: "stat-sub"
  }, /*#__PURE__*/React.createElement("span", {
    className: "stat-delta up"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "trend_up"
  }), "+22%"), " YoY"))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-label"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "check"
  }), "Collected"), /*#__PURE__*/React.createElement("div", {
    className: "stat-value"
  }, "$1.08M"), /*#__PURE__*/React.createElement("div", {
    className: "stat-sub"
  }, /*#__PURE__*/React.createElement("span", {
    className: "stat-delta up"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "trend_up"
  }), "+14%"), " YoY"))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-label"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "alert"
  }), "Outstanding"), /*#__PURE__*/React.createElement("div", {
    className: "stat-value"
  }, "$46.2k"), /*#__PURE__*/React.createElement("div", {
    className: "stat-sub"
  }, /*#__PURE__*/React.createElement("span", {
    className: "stat-delta down"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "trend_down"
  }), "-8%"), " vs Q3")))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-head"
  }, /*#__PURE__*/React.createElement("h3", null, "Booked vs collected"), /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, "Monthly")), /*#__PURE__*/React.createElement("div", {
    className: "card-body"
  }, /*#__PURE__*/React.createElement(AreaChart, {
    data: REV,
    keys: ['booked', 'collected'],
    h: 220
  }))));
}
function EventDrawer({
  event,
  onClose
}) {
  if (!event) return null;
  return /*#__PURE__*/React.createElement(Drawer, {
    open: !!event,
    onClose: onClose,
    onOpenPage: () => {},
    crumb: /*#__PURE__*/React.createElement(React.Fragment, null, "Events ", /*#__PURE__*/React.createElement("span", {
      style: {
        opacity: .5
      }
    }, "\u203A"), " ", /*#__PURE__*/React.createElement("strong", {
      style: {
        color: 'var(--ink-1)'
      }
    }, event.name)),
    footer: /*#__PURE__*/React.createElement("div", {
      className: "drawer-head",
      style: {
        borderTop: '1px solid var(--line-1)',
        borderBottom: 0
      }
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn btn-secondary"
    }, "Message client"), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-primary btn-full"
    }, "Assign staff"))
  }, /*#__PURE__*/React.createElement("div", {
    className: "drawer-hero"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hstack",
    style: {
      gap: 8,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(StatusChip, {
    kind: event.status[0]
  }, event.status[1]), event.priv && /*#__PURE__*/React.createElement("span", {
    className: "tag"
  }, "Private")), /*#__PURE__*/React.createElement("h2", null, event.name), /*#__PURE__*/React.createElement("div", {
    className: "sub"
  }, event.date, " \xB7 6:00 \u2013 11:00 PM"), /*#__PURE__*/React.createElement("div", {
    className: "meta"
  }, /*#__PURE__*/React.createElement("div", {
    className: "meta-item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "meta-k"
  }, "Client"), /*#__PURE__*/React.createElement("span", {
    className: "meta-v"
  }, event.client)), /*#__PURE__*/React.createElement("div", {
    className: "meta-item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "meta-k"
  }, "Guests"), /*#__PURE__*/React.createElement("span", {
    className: "meta-v num"
  }, event.guests)), /*#__PURE__*/React.createElement("div", {
    className: "meta-item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "meta-k"
  }, "Total"), /*#__PURE__*/React.createElement("span", {
    className: "meta-v num"
  }, event.total)))), /*#__PURE__*/React.createElement("div", {
    className: "section-title"
  }, "Staffing"), /*#__PURE__*/React.createElement("div", {
    className: "hstack",
    style: {
      marginBottom: 12
    }
  }, pills(event.staff)), /*#__PURE__*/React.createElement("div", {
    className: "section-title"
  }, "Documents"), /*#__PURE__*/React.createElement("div", {
    className: "drawer-row"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "drawer-row-name"
  }, "Signed BEO.pdf"), /*#__PURE__*/React.createElement("div", {
    className: "drawer-row-meta"
  }, "Uploaded Jun 2")), /*#__PURE__*/React.createElement(StatusChip, {
    kind: "ok",
    dot: false
  }, "Signed")), /*#__PURE__*/React.createElement("div", {
    className: "drawer-row"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "drawer-row-name"
  }, "Certificate of insurance"), /*#__PURE__*/React.createElement("div", {
    className: "drawer-row-meta"
  }, "Requested from venue")), /*#__PURE__*/React.createElement(StatusChip, {
    kind: "warn",
    dot: false
  }, "Awaiting")));
}
window.AdminScreens = {
  Dashboard,
  Events,
  Financials,
  EventDrawer
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/admin/screens.jsx", error: String((e && e.message) || e) }); }

// ui_kits/staff/screens.jsx
try { (() => {
/* Staff portal UI kit — screen bodies for the mobile PWA. */
const DS = window.DrBartenderOSDesignSystem_720350;
const {
  NextEventCard,
  ShiftRow,
  PayoutRow,
  StatusChip,
  Icon
} = DS;
function Home({
  go
}) {
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "sp-hero"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sp-greeting"
  }, "Evening, Mara"), /*#__PURE__*/React.createElement("div", {
    className: "sp-greeting-sub"
  }, "Tue \xB7 Jun 10")), /*#__PURE__*/React.createElement("div", {
    className: "sp-section-k"
  }, "Next shift"), /*#__PURE__*/React.createElement(NextEventCard, {
    shift: {
      name: 'Vantage Rooftop',
      when: 'Sat · Jun 14',
      rel: 'In 3d',
      time: '6:00 – 11:00 PM',
      venue: 'Downtown',
      pay: '$220',
      state: 'needs-action'
    },
    onConfirm: () => {},
    onDetails: () => go('shifts')
  }), /*#__PURE__*/React.createElement("div", {
    className: "sp-section-k"
  }, "Needs you"), /*#__PURE__*/React.createElement("button", {
    className: "sp-action"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sp-action-icon"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "pen",
    size: 16
  })), /*#__PURE__*/React.createElement("span", {
    className: "sp-action-main"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sp-action-title"
  }, "Confirm availability"), /*#__PURE__*/React.createElement("span", {
    className: "sp-action-sub"
  }, "Week of Jun 16 \xB7 closes Fri")), /*#__PURE__*/React.createElement(Icon, {
    name: "right",
    className: "sp-chev"
  })), /*#__PURE__*/React.createElement("button", {
    className: "sp-action"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sp-action-icon danger"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "card",
    size: 16
  })), /*#__PURE__*/React.createElement("span", {
    className: "sp-action-main"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sp-action-title"
  }, "Add your tip card"), /*#__PURE__*/React.createElement("span", {
    className: "sp-action-sub"
  }, "Get paid tips directly")), /*#__PURE__*/React.createElement(Icon, {
    name: "right",
    className: "sp-chev"
  })), /*#__PURE__*/React.createElement("div", {
    className: "sp-section-k",
    style: {
      marginTop: 4
    }
  }, "This pay period ", /*#__PURE__*/React.createElement("span", {
    className: "sp-card-link",
    onClick: () => go('pay')
  }, "View pay")), /*#__PURE__*/React.createElement("div", {
    className: "sp-earnings",
    onClick: () => go('pay'),
    style: {
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "sp-earnings-k"
  }, "Jun 1 \u2013 15"), /*#__PURE__*/React.createElement("div", {
    className: "sp-earnings-sub"
  }, "3 shifts \xB7 pays Jun 20")), /*#__PURE__*/React.createElement("div", {
    className: "sp-earnings-v"
  }, "$1,240")));
}
const SHIFTS = [{
  name: 'Vantage Rooftop',
  when: 'Sat · Jun 14',
  rel: 'In 3d',
  today: false,
  time: '6:00 – 11:00 PM',
  pay: '$220',
  state: 'needs-action'
}, {
  name: 'Harbor Loft',
  when: 'Sun · Jun 22',
  time: '5:00 – 10:00 PM',
  pay: '$185',
  state: 'confirmed'
}, {
  name: 'Gallery 9 Opening',
  when: 'Fri · Jul 4',
  time: '7:00 PM – 1:00 AM',
  pay: '$260',
  state: 'confirmed'
}];
function Shifts() {
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("h1", null, "Shifts"), /*#__PURE__*/React.createElement("div", {
    className: "sp-section-k"
  }, "Upcoming"), SHIFTS.map((s, i) => /*#__PURE__*/React.createElement(ShiftRow, {
    key: i,
    shift: s
  })), /*#__PURE__*/React.createElement("div", {
    className: "sp-section-k",
    style: {
      marginTop: 6
    }
  }, "Past"), /*#__PURE__*/React.createElement(ShiftRow, {
    shift: {
      name: 'Meridian Gala',
      when: 'Sat · Jun 1',
      time: '6:00 – 11:00 PM',
      pay: '$210'
    }
  }));
}
function Pay() {
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("h1", null, "Pay"), /*#__PURE__*/React.createElement("div", {
    className: "sp-earnings",
    style: {
      borderColor: 'var(--sp-accent)'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "sp-earnings-k"
  }, "Current period \xB7 Jun 1\u201315"), /*#__PURE__*/React.createElement("div", {
    className: "sp-earnings-sub"
  }, "3 shifts worked")), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'right'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "sp-earnings-v"
  }, "$1,240"), /*#__PURE__*/React.createElement(StatusChip, {
    kind: "warn",
    dot: false
  }, "Pending"))), /*#__PURE__*/React.createElement("div", {
    className: "sp-section-k",
    style: {
      marginTop: 6
    }
  }, "History"), /*#__PURE__*/React.createElement(PayoutRow, {
    label: "May 16 \u2013 31",
    period: "Paid Jun 5",
    amount: "$1,410",
    status: "Paid",
    statusKind: "ok"
  }), /*#__PURE__*/React.createElement(PayoutRow, {
    label: "May 1 \u2013 15",
    period: "Paid May 20",
    amount: "$980",
    status: "Paid",
    statusKind: "ok"
  }), /*#__PURE__*/React.createElement(PayoutRow, {
    label: "Apr 16 \u2013 30",
    period: "Paid May 5",
    amount: "$1,120",
    status: "Paid",
    statusKind: "ok"
  }));
}
function TipCard() {
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("h1", null, "Tip Card"), /*#__PURE__*/React.createElement("div", {
    className: "sp-earnings",
    style: {
      flexDirection: 'column',
      alignItems: 'stretch',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "sp-earnings-k"
  }, "Tips this month"), /*#__PURE__*/React.createElement("div", {
    className: "sp-earnings-v"
  }, "$486"), /*#__PURE__*/React.createElement("div", {
    className: "sp-earnings-sub"
  }, "Paid directly to your card \xB7 14 tips")), /*#__PURE__*/React.createElement("div", {
    className: "sp-section-k",
    style: {
      marginTop: 6
    }
  }, "Your tip link"), /*#__PURE__*/React.createElement("div", {
    className: "sp-action",
    style: {
      cursor: 'default'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "sp-action-icon info"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "card",
    size: 16
  })), /*#__PURE__*/React.createElement("span", {
    className: "sp-action-main"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sp-action-title"
  }, "drbar.tips/mara"), /*#__PURE__*/React.createElement("span", {
    className: "sp-action-sub"
  }, "Guests scan to tip you")), /*#__PURE__*/React.createElement(Icon, {
    name: "copy",
    className: "sp-chev"
  })), /*#__PURE__*/React.createElement("button", {
    className: "sp-btn sp-btn-primary sp-btn-full",
    style: {
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "send",
    size: 15
  }), "Share tip link"));
}
window.StaffScreens = {
  Home,
  Shifts,
  Pay,
  TipCard
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/staff/screens.jsx", error: String((e && e.message) || e) }); }

__ds_ns.CommandPalette = __ds_scope.CommandPalette;

__ds_ns.KebabMenu = __ds_scope.KebabMenu;

__ds_ns.Icon = __ds_scope.Icon;

__ds_ns.ICON_NAMES = __ds_scope.ICON_NAMES;

__ds_ns.AreaChart = __ds_scope.AreaChart;

__ds_ns.MetricTile = __ds_scope.MetricTile;

__ds_ns.MetricsFilterBar = __ds_scope.MetricsFilterBar;

__ds_ns.Sparkline = __ds_scope.Sparkline;

__ds_ns.Header = __ds_scope.Header;

__ds_ns.DEFAULT_NAV = __ds_scope.DEFAULT_NAV;

__ds_ns.Sidebar = __ds_scope.Sidebar;

__ds_ns.Toolbar = __ds_scope.Toolbar;

__ds_ns.DocumentPreviewModal = __ds_scope.DocumentPreviewModal;

__ds_ns.Drawer = __ds_scope.Drawer;

__ds_ns.NextEventCard = __ds_scope.NextEventCard;

__ds_ns.PayoutRow = __ds_scope.PayoutRow;

__ds_ns.ShiftRow = __ds_scope.ShiftRow;

__ds_ns.STAFF_TABS = __ds_scope.STAFF_TABS;

__ds_ns.StaffTabBar = __ds_scope.StaffTabBar;

__ds_ns.StaffUserPillMenu = __ds_scope.StaffUserPillMenu;

__ds_ns.StaffPills = __ds_scope.StaffPills;

__ds_ns.StatusChip = __ds_scope.StatusChip;

__ds_ns.DataTableRow = __ds_scope.DataTableRow;

})();
