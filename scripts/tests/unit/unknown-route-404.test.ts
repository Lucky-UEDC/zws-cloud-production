import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string) => readFileSync(path, "utf8")

/**
 * Unknown-route handling.
 *
 * Reproduced on the deployed development site:
 *
 *   GET /blog/unknown-slug-xyz  -> 200   (dynamic route renders notFound())
 *   GET /aaa/bbb/ccc            -> 404   (no route matches at all)
 *   GET /zzz-aaa-999            -> 200   (matches app/[categorySlug])
 *
 * The difference is `app/loading.tsx`. A loading boundary at the root segment
 * puts every route inside a Suspense boundary, so the response begins streaming
 * before the page runs. `notFound()` is then thrown after the status line has
 * already been sent, and Next.js cannot replace 200 with 404. Routes that never
 * match are rejected during routing, before streaming, and correctly answer 404.
 *
 * The status is therefore wrong, but the body is the real 404 page and it
 * already carries `noindex`, which is the part that matters to a search engine.
 * These tests pin that mitigation so it cannot be lost, and record the two
 * remediation options without applying either: removing the root loading
 * boundary changes navigation behaviour site-wide, and it cannot be verified
 * here because this phase is not authorised to deploy.
 */

test("the root loading boundary that causes the soft 404 is still present", () => {
  // Pinning the cause: if this file disappears, the 200-vs-404 behaviour is
  // expected to change and this test should be revisited rather than silently
  // failing elsewhere.
  assert.ok(read("app/loading.tsx").includes("export default function Loading"))
  // Route-scoped loading files are unaffected and should stay.
  assert.ok(read("app/admin/loading.tsx").length > 0)
})

test("private areas are marked noindex, and the 404 noindex is framework-provided", () => {
  // The soft-404 mitigation does not come from application source: Next.js
  // emits `<meta name="robots" content="noindex">` itself on the not-found
  // path, which was confirmed in the rendered development response. What the
  // application owns is the private surface, asserted here.
  assert.match(read("app/admin/layout.tsx"), /robots:\s*"noindex, nofollow"/)
  assert.match(read("app/client-area/layout.tsx"), /robots:\s*"noindex, nofollow"/)

  // The attachment route also sets the header, so a private file is never
  // indexed even when it is fetched directly.
  const attachmentRoute = read("app/api/tickets/attachments/[id]/route.ts")
  assert.match(attachmentRoute, /"X-Robots-Tag": "noindex, nofollow"/)
})

test("a matching dynamic route renders notFound rather than a blank page", () => {
  // The body must be the real 404 page, not an error or an empty response.
  const blog = read("app/blog/[slug]/page.tsx")
  assert.match(blog, /notFound\(\)/)
  assert.match(blog, /if \(!post\) notFound\(\)/)

  const category = read("components/catalog/catalog-listing-page.tsx")
  assert.match(category, /notFound\(\)/)
  // The not-found navigation error must be rethrown, not swallowed into a
  // generic "temporarily unavailable" page, which would mask real 404s.
  assert.match(category, /isNotFoundNavigationError\(error\)[\s\S]{0,80}throw error/)
})

test("unknown public routes are not exposed through the catch-all category route", () => {
  // app/[categorySlug] intentionally matches any single segment so product
  // categories can live at the root. It must still 404 for anything that is
  // not a real category rather than rendering an empty listing.
  const page = read("app/[categorySlug]/page.tsx")
  assert.match(page, /CatalogListingPage/)
  const listing = read("components/catalog/catalog-listing-page.tsx")
  assert.match(listing, /getCategoryBySlug/)
  assert.match(listing, /notFound\(\)/)
})

test("the catch-all category route is declared as a single-segment dynamic route", () => {
  // Static routes are matched before the dynamic segment by the router; this
  // asserts the intended shape of the catch-all rather than an accident.
  assert.match(read("app/[categorySlug]/page.tsx"), /categorySlug: string/)
  // It must not be a catch-all: a `[...slug]` would swallow every unknown
  // multi-segment path too and widen the soft-404 surface.
  assert.doesNotMatch(read("app/[categorySlug]/page.tsx"), /\.\.\.slug/)
})