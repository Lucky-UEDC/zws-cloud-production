# Proposed Issue: Unknown Routes Return HTTP 200 (Soft 404)

Status: **deferred, not modified in this hardening branch.** This document is a
separate change proposal; `app/loading.tsx` is untouched.

## Root cause

The root loading boundary (`app/loading.tsx`) renders a Suspense-backed
`PageShellSkeleton` immediately and commits the HTTP response before any
nested `app/not-found.tsx` route is allowed to set a 404 status. In the App
Router, a `loading.tsx` at the root boundary causes an initial `200` response
with the skeleton stream; when the underlying route subsequently resolves to
`notFound()`, the rendered body becomes the `not-found.tsx` content, but the
already-committed status (200) stays put.

Observed impact: every unknown URL returns 200 with the SPA shell instead of
404. Reproduced by a request to a random path; the `metadata`/robots
mitigation (noindex) is present but the status code is wrong, which breaks
sitemap triage, search quality, and basic HTTP semantics.

## Affected routes

- All routes not matched by the filesystem router (the root-level catch-all).
- Nested routes that call `notFound()` after Suspense commits.
- Automated audits that rely on status codes (SEO, monitoring).

## Current mitigation (do not remove)

- `app/not-found.tsx` provides the user-facing 404 UI.
- Layout provides `robots` metadata / `X-Robots-Tag` noindex on private areas.
- Unknown route tests in `scripts/tests/unit/unknown-route-404.test.ts` record
  the current 200 behaviour so it is explicit, not silent.

## Expected behaviour after patch

- A request that resolves to `notFound()` must set `HTTP/... 404` **before**
  any bytes of the document are streamed.
- Known routes keep their streaming skeleton; only unmatched/not-found
  transition paths lose the early skeleton.

## Proposed technical change (review required first)

1. Remove the **root** `app/loading.tsx` skeleton gating, or replace it with a
   boundary that does not commit a 200 before `notFound()` resolution.
2. Route-level skeletons under `app/(segments)/loading.tsx` remain (they are
   confined to known routes and never wrap a 404).
3. Add a regression test that asserts `response.status` and redirects re-
   rendered under `NEXT_ROUTER_APP_DIR` routing semantics.
4. Run a full route scan for 200-with-not-found-content to ensure no
   regression on the dashboard layout, which depends on early skeleton fill.

## Regression tests required

- An integration smoke that fetches five random paths and asserts 404.
- A test that fetches the known root path and asserts 200.
- A Playwright/browser smoke checking the title "This page drifted off-network."
- No weakening of the existing `app/loading.tsx` removal guard until the
  dashboard perf impact has been measured.

## Rollback

- Revert the single commit; `app/loading.tsx` is re-added as a root-level
  skeleton. The mitigation stays unchanged either way.
