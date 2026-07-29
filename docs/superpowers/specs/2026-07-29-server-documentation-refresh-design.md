# Server Documentation Refresh Design

**Date:** 2026-07-29  
**Scope:** `README.md` and `AGENTS.md` in `intervals.icu-server` only.

## Goal

Make the public README and canonical agent instructions match the current OAuth Worker, local development paths, 24-tool server surface, and split-workout reconciliation safeguards.

## Sources of Truth

- `src/index.ts` for Worker routes, OAuth behavior, and settings-session lifetime.
- `src/stdio.ts` and `test/stdio.test.ts` for local stdio behavior and the 24 registered tools.
- `src/tools/*.ts` for tool names and descriptions.
- `src/tools/split-reconciliation.ts` and its tests for reconciliation eligibility and mutation safeguards.
- `wrangler.toml` and `.gitignore` for local Worker bindings and ignored `.dev.vars` secrets.

## Documentation Changes

### README

Keep the existing hosted OAuth quick start, local stdio setup, 24-tool table, and analysis semantics.

Add a **Developer setup: local OAuth Worker** section between remote Worker and local stdio setup. It will document:

- Separate development GitHub and Google OAuth clients, so production callback settings are not replaced.
- `http://localhost:8787/callback` as the local redirect URI.
- An ignored `.dev.vars` file containing the local client IDs, provider secrets, and a 32-byte-hex `CREDENTIALS_MASTER_KEY`.
- `npm run dev` as the local Worker command, `http://localhost:8787/settings` for provider sign-in and credential setup, and `http://localhost:8787/mcp` as the local MCP endpoint.
- Local Wrangler KV state being separate from production state, and the requirement that an MCP client must be able to reach localhost.

Expand the architecture tree to include `styles.ts`, `analysis.ts`, weekly snapshot, split reconciliation, analysis tools, and their tests.

Add concise split-workout semantics near the tool/analysis guidance:

- `Ride` and `VirtualRide` are one cycling family; planned indoor metadata is not an eligibility gate.
- Completed intensity above 80% or absent intensity is advisory only; no override exists.
- Apply requires explicit confirmation and an unchanged preview fingerprint rebuilt from current detailed records before any write.
- A failed apply reports rollback status only after read-back verification; unknown creation outcomes remain incomplete.

### AGENTS.md

Correct the settings-session lifetime from one hour to seven days in both KV-key and expiry guidance.

Update the project structure and route summary:

- Include `/` and `/help` in default-handler routes.
- Name the activity route tool instead of “sampled streams.”
- Keep the complete weekly snapshot, split reconciliation, and analysis entries aligned with actual registrations.

Add compact agent-facing instructions for:

- Local OAuth Worker development: use `.dev.vars`, local provider clients, the localhost callback, and local Wrangler KV; do not use production credentials or redirect settings for development.
- Split reconciliation: preserve cycling-family grouping, advisory-only intensity behavior, explicit approval, detailed pre-write revalidation, and verified/conservative rollback behavior.

## Exclusions

- No source-code, API, OAuth configuration, deployment, or MCP schema changes.
- No edits to `intervals.icu-coach`, its skill sources, or the flat local `.agents` copy.
- No attempt to refresh an already-loaded Codex MCP schema; that requires reconnecting the configured connector.

## Validation

- Confirm the README tool table still lists all 24 names from `test/stdio.test.ts`.
- Confirm the local OAuth section matches `callbackUrl()` and the current `npm run dev` script.
- Confirm AGENTS lists a seven-day settings session and current route/tool terminology.
- Search both docs for obsolete one-hour session and old outdoor/80%-hard-stop reconciliation language.
- Run `git diff --check` and inspect the final documentation diff.
