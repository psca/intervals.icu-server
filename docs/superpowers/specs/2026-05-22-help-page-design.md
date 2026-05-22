# Help Page Design

Date: 2026-05-22
Branch: `feat/auth`

## Goal

Add a simple public `/help` page for end users of the remote Cloudflare Worker deployment. The page should explain how to connect the MCP server from ChatGPT and Claude, and how to find the required intervals.icu athlete ID and API key.

This page is intended for regular users. The repository `README.md` remains the operator/deployer document.

## Scope

In scope:

- Add public `GET /help`
- Render the page with the existing server-side HTML pattern used by `src/index.ts`
- Add a small in-page nav with anchor links
- Add sections for `ChatGPT`, `Claude`, and `intervals.icu`
- Link to `/help` from sign-in and credential-related pages
- Add a targeted link to `/help#intervals-icu` near the athlete ID / API key form guidance
- Add tests for the new route and help links

Out of scope:

- Frontend frameworks such as React or shadcn
- Multi-page docs, search, or rich docs infrastructure
- Troubleshooting content beyond minimal setup guidance
- Deployment/operator instructions currently covered by the `README.md`

## Approach

Use the existing Worker-rendered HTML model.

The current app already returns complete HTML documents from `src/index.ts` and shares styling through `src/styles.ts`. The help page should follow the same pattern. This keeps the implementation aligned with the Worker architecture, avoids adding a frontend build/runtime layer, and makes the docs page easy to deploy and maintain.

The page should remain public so users can read it before authentication begins and so connector setup can link to a stable URL.

## Route Design

Add a new unauthenticated route:

- `GET /help`

Behavior:

- Returns `200 OK`
- Returns HTML with the same base CSS style as the existing auth/settings pages
- Includes a compact top nav linking to:
  - `#chatgpt`
  - `#claude`
  - `#intervals-icu`

No session or OAuth state is required for this page.

## Content Design

The page should be concise and task-oriented.

### Section: ChatGPT

Purpose:

- Tell the user which MCP URL to provide
- Explain that the connector flow will open browser authentication

Content:

- Remote MCP URL format using the current worker origin and `/mcp`
- Short numbered steps to add the connector in ChatGPT
- Short note that provider sign-in and intervals.icu credential entry happen afterward

### Section: Claude

Purpose:

- Explain the same remote connection flow for Claude users

Content:

- Remote MCP URL format using the current worker origin and `/mcp`
- Short steps for Claude’s connector flow
- Short note that the browser auth flow opens and then redirects back

The copy should avoid overcommitting to client UI wording that may drift. It should describe the task clearly without depending on fragile product labels where possible.

### Section: intervals.icu

Purpose:

- Help users find the two values the worker asks for after provider login

Content:

- Explain that the Worker needs:
  - Athlete ID
  - API key
- Explain where to find them in intervals.icu settings/API pages
- Explain the expected athlete ID format using the current app convention (for example `i12345`)

This section is the target for direct help links from credential-entry screens.

## Linking Changes

Add discoverable links from existing pages:

- Sign-in/provider-choice page: add a small `Help` link
- Settings page: add `Help` link
- Configure credentials page: add a targeted link to `/help#intervals-icu`

The targeted link should be placed near the athlete ID / API key guidance so users can recover without leaving the task flow mentally.

## UI Design

Keep the UI minimal and consistent with the existing pages.

Expected characteristics:

- Reuse `PAGE_CSS` with small additions if needed
- Maintain the same card-based centered layout
- Add a compact top nav or section link row inside the card
- No JS required
- No external assets required

Provider icons for login buttons are a valid follow-up task, but not required for this help page design.

## Implementation Notes

To keep `src/index.ts` manageable, small render helpers may be introduced if the added HTML becomes noisy. This should stop short of introducing a component framework. String-based server rendering remains the intended model.

If helpful, use one or more helper functions for:

- rendering the `/help` page
- rendering reusable page-level help links

## Testing

Add focused tests in `test/index.test.ts` for:

- `GET /help` returns `200`
- `/help` body includes the expected section anchors
- provider-choice page includes a help link
- credentials/configure page includes the targeted `/help#intervals-icu` link
- settings page includes a help link

No new end-to-end harness is required for this change.

## Risks and Constraints

- Product UI wording in ChatGPT/Claude can drift over time, so copy should stay generic enough to avoid frequent updates
- The help page should not include secrets or deployer-only operational details
- The public page must remain useful even when the user is not authenticated

## Success Criteria

This design is successful if:

- A new user can discover `/help` without authentication
- A user on the login or configure pages can find setup guidance quickly
- The page explains connector setup and intervals.icu credential retrieval without requiring the repository README
- The implementation fits the current Worker architecture without adding frontend framework complexity
