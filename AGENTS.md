# BestWord implementation

The user authorized autonomous implementation and testing of the agreed plan. Do not buy services, deploy publicly, or send messages to others. Work only in this repository for deliverables; use the task's work directory for external toolchains and scratch assets.

Read docs/DECISIONS.md and docs/original-spec.txt. The source dictionary is data/dictionary.txt. Do not change vocabulary or game rules casually.

Save milestone notes under docs/progress/. Keep unexecuted checks clearly marked. Use real PostgreSQL/Redis-compatible integration tests wherever available; test doubles do not establish production recovery or capacity.

Root owns central package scripts, shared contracts, server, integration, and deployment. Delegated agents own only their assigned directories. Coordinate contract changes before editing shared files. No public deployment, paid cloud testing, or credential changes.

Code uses strict TypeScript with exact optional properties and unchecked-index protection. No raw game state may leak private racks, consonant bag counts, sessions, or drafts to public viewers. Accepted moves must be durable and idempotent.
