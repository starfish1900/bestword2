# Client implementation progress

- Implemented real same-origin HTTP authentication, password change, live seeks, match creation/join/cancellation, live watch list, completed game list, cursor pagination, and active-game resume link.
- Implemented global game:matched navigation, WebSocket-only Socket.IO subscription/synchronization, server-time clocks, recovery/disconnect notices, revision ordering, public/player-specific views, and acknowledgement-loss retry using the same command ID persisted per tab.
- Implemented viewport-sized accessible DOM board, exact keyboard move inference, click alternation, inventory reservation, backspace across existing tiles, clearing, tap rack/vowels, PASS confirmation, NO WORDS eligibility, move score breakdown, public replay and step/auto-play controls.
- Added a complete ivory/navy/gold interface using local system fonts and CSS only. Portrait and landscape rules include 320x568 and short landscape layouts. No remote visual assets or fonts.
- Draft helper tests: 5 passing, including MASTERPIECE inference, vertical skips, inventory reservation including Y, edge wrapping, and click semantics. Replay regression test added.
- Initial typecheck: all React/client source passes; build configuration blocked by duplicated Vite7 (web) versus Vite8 (root/plugin) types. Root notified to deduplicate Vite7 before integrated verification.
- Still to perform: deduplicated build/typecheck; live API/browser workflows and screenshot inspection across viewport sizes. Do not treat current CSS as visually verified yet.
