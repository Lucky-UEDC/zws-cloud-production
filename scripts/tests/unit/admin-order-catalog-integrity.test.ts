import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const page = readFileSync(join(process.cwd(), "app/admin/orders/new/page.tsx"), "utf8")

describe("admin create-order catalog", () => {
  it("surfaces a failed catalog API instead of rendering an empty list", () => {
    // Production symptom: "Product: Select product" with INR 0 pricing, caused
    // by a 401 from /api/admin/products being swallowed into an empty array.
    assert.ok(page.includes("setLoadError"), "a load failure must be recorded")
    assert.ok(page.includes("Products could not be loaded"), "the products failure must name itself")
    assert.equal(page.includes("if (productsRes.ok) setProducts(productsBody.products || [])"), false, "the swallow must be gone")
  })

  it("shows the failure next to the selector, not only as a toast", () => {
    assert.ok(page.includes("Order form data is incomplete"), "the page must say the form is incomplete")
    assert.ok(page.includes("An empty product list means the catalog could not be read"), "it must explain the empty-list case")
  })

  it("explains an empty dropdown rather than showing a bare placeholder", () => {
    assert.ok(page.includes("emptyMessage"), "SelectField must be able to say why it is empty")
    assert.ok(page.includes("No active products in the catalog"), "a genuinely empty catalog must read differently from a failed load")
    assert.ok(page.includes("Products could not be loaded"), "a failed load must say so in the dropdown too")
  })

  it("shows each product's price so INR 0 is visibly wrong", () => {
    assert.ok(page.includes("price1m"), "product options must include their price")
  })

  it("fails loudly on every dependency, not just products", () => {
    for (const dependency of ["Offers could not be loaded", "Operating systems could not be loaded", "Nodes could not be loaded", "IP pools could not be loaded"]) {
      assert.ok(page.includes(dependency), `missing failure message: ${dependency}`)
    }
  })
})
