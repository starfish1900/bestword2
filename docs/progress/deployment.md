# Deployment preparation

Updated 18 September 2026. Scope: Dockerfile, Docker ignore rules, Compose, Render Blueprint, deployment validator, CI and operations documentation. No remote resources created, no purchase, no public deployment.

## Delivered

- Multi-stage Node 24 Debian container: Linux dependency install and production build, development dependency pruning, unprivileged runtime, direct Node process, compressed prebuilt lexicon. Shared image supports API and worker.
- Git attributes preserve the original dictionary and binary lexicon bytes across Windows/Linux checkouts, so source checksum and reproducible-compiler checks are not changed by automatic line-ending conversion.
- Canonical local Compose: PostgreSQL 18, Valkey 8 with persistence, one-shot migration, API and continuous worker; loopback-only host ports and persistent named volumes. PostgreSQL 18 mounts its versioned data parent correctly.
- Render Virginia paid Blueprint: API $25, worker $7, database $19 plus $3 storage, Key Value $10. Indicative Hobby base $64/month before usage/tax, one instance per role, admission 100 games/10 spectators each, manual deployment, private datastores, no preview/automatic storage scaling.
- CI configured for full build/type checking, audit, real PostgreSQL/Valkey integration, Chromium/Firefox/WebKit, a short multiplayer load smoke, Rust graph byte reproduction and complete container smoke startup. It does not deploy or publish an image.
- `docs/OPERATIONS.md`: local lifecycle, pricing, release/migration/rollback procedure, metrics, health and recovery semantics, database backup/restore drill, disaster-recovery limitations and capacity gates.

## Executed verification

- Read current implementation configuration, lifecycle, migrations, health/metrics and package scripts.
- Retrieved current official Render documentation and prices. The schema uses the new August 2026 resource plan IDs, which correspond to the documented resource sizes.
- Parsed all three YAML files using YAML 1.2 boolean semantics and checked them against the current Render, Compose and GitHub Actions JSON schemas: passed.
- Checked private database/Key Value references, Virginia placement, manual instance limits, host loopback bindings and PostgreSQL 18 volume path through `deployment/validate.py`.
- Manually reviewed Docker build inputs, workspace package links, compiled runtime paths, native dependency platform selection, non-root ownership, signal handling and the excluded local secret/data paths.

## Not executed here

Docker/Compose execution, Linux image build, CI hosted run, Render authenticated semantic validation, actual provision/deploy, paid cloud load test and production restoration. Docker is unavailable on this Windows machine and was not installed. The local services are real PostgreSQL 18.4 plus Redis 7.2.16, not Valkey 8. These distinctions must remain visible in release claims. A separate real local logical backup/restore drill passed; see [backup evidence](backup.md).

The 100-game setting is an admission target, not a measured capacity result. Costs are not capped by the game limit, and the $100 target does not establish support for 5,000 concurrent games. A historical database restore needs explicit unfinished-game reconciliation; there is currently no one-click admin restore command.
