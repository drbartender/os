repo: drbartender/os
branch: main
path: client/src

## Last sync
date: 2026-10-06T08:31:40Z

### Updated in this project
- New Inbox screen designed on top of the phone admin chrome and desktop shell
- Phone chrome, cards, sections, sheets and states lifted from shipped index.css m-* rules
- Desktop shell (sidebar, presence strip, header) and neighbors (Messages, NeedsYouStrip) read from source

## Screen map
| Project screen | Repo files |
|---|---|
| InboxPhone.dc.html (list, item, handled, states) | client/src/components/AdminLayout.js, client/src/components/mobile/MobileTabBar.js, client/src/components/mobile/MobileHeader.js, client/src/pages/mobile/EventsListPhone.js, client/src/pages/mobile/EventDetailPhone.js, client/src/pages/mobile/EventDetailSections.js, client/src/pages/mobile/MorePage.js, client/src/index.css, docs/design-artifacts/2026-09-15-mobile-admin-shell.dc.html |
| InboxDesktop.dc.html | client/src/components/AdminLayout.js, client/src/components/adminos/Sidebar.js, client/src/components/adminos/PresenceStrip.js, client/src/components/adminos/Header.js, client/src/components/adminos/GlobalSearchButton.js, client/src/components/adminos/nav.js, client/src/pages/admin/Messages.js, client/src/components/ClientConversation.js, client/src/pages/admin/overview/NeedsYouStrip.js, client/src/index.css |
| Inbox.dc.html (canvas) | composes the two above |
