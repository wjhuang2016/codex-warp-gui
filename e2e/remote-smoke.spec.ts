import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer } from "./fixtureServer";

test.describe("remote web UI (server-hosted)", () => {
  let baseUrl = "";
  let stop: (() => Promise<void>) | null = null;

  test.beforeAll(async () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const repoRoot = path.resolve(__dirname, "..");
    const started = await startFixtureServer(repoRoot);
    baseUrl = started.baseUrl;
    stop = started.stop;
  });

  test.afterAll(async () => {
    await stop?.();
  });

  test("loads sessions, renders blocks, supports rename/delete", async ({ page }) => {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    const sessionA = page.locator(".sessionTitle", { hasText: "Smoke Session A" });
    const sessionB = page.locator(".sessionTitle", { hasText: "Smoke Session B" });
    await expect(sessionA).toBeVisible();
    await expect(sessionB).toBeVisible();

    // Sorted by recency: A should appear above B.
    const titles = page.locator(".sessionTitle");
    await expect(titles.first()).toHaveText("Smoke Session A");

    await sessionA.click();
    await expect(page.locator(".blockTitle", { hasText: "Prompt" })).toBeVisible();
    await expect(page.locator(".blockBody", { hasText: "Hello from A" })).toBeVisible();

    // TODO panel should parse tasks from assistant markdown.
    await expect(page.locator(".todoLabel", { hasText: "alpha task" })).toBeVisible();
    // And plan events should populate the TODO panel too.
    await expect(page.locator(".todoLabel", { hasText: "Plan step 1" })).toBeVisible();

    // Switching sessions should render that session's blocks and TODOs (not stale from A).
    await sessionB.click();
    await expect(page.locator(".blockBody", { hasText: "Hello from B" })).toBeVisible();
    await expect(page.locator(".todoLabel", { hasText: "alpha task" })).toHaveCount(0);
    await expect(page.locator(".todoLabel", { hasText: "Plan step 1" })).toHaveCount(0);

    // Switch back.
    await sessionA.click();
    await expect(page.locator(".blockBody", { hasText: "Hello from A" })).toBeVisible();

    // Rename active session.
    await page.getByRole("button", { name: "Rename" }).click();
    const titleInput = page.locator('input[placeholder="Session title"]');
    await expect(titleInput).toBeVisible();
    await titleInput.fill("Renamed Session A");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".sessionTitle", { hasText: "Renamed Session A" })).toBeVisible();

    // Delete active session.
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator(".sessionTitle", { hasText: "Renamed Session A" })).toHaveCount(0);
    await expect(page.locator(".sessionTitle", { hasText: "Smoke Session B" })).toBeVisible();
  });
});
