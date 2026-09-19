# AI and client improvements — implementation record

## Approved scope

Implement exact anchor/cross-check/GADDAG search, restricted Easy/Medium vocabulary, bounded strategic NO WORDS lookahead, durable server AI games with normal clocks, persistent Recent games pagination, authenticated replay, and unchanged tutorial integration through every help link. No paid services or public deployment.

## Initial checkpoint

- Desktop source intersections confirmed: Easy 9,868/9,870, Medium 38,359/38,369; Easy is a subset of Medium.
- Existing full dictionary remains 279,320 entries with original SHA-256 `87222d75c77c52574868bf0cefd4faf5703d4df166336a4ec9a70cffe72100af`.
- Search, server, and client implementation proceed in separate assigned areas; root owns public contracts, replay delivery enforcement, integration and release configuration.
- Public live snapshots now have explicit history access, move count, tile origins, last move tiles and recent summaries. Full history will be delivered only after authentication.
- Task-local PostgreSQL18 and Redis7 started for real integration tests. No public resources created.

## Pending checks

Implementation and all acceptance checks are in progress. No AI capacity claim is established yet. Previous human-only capacity evidence remains historical.
