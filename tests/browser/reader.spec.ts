import { devices, expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const screenshotDirectory = process.env.GEOLENS_SCREENSHOTS;

async function screenshot(page: Page, filename: string, fullPage = false) {
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  // Decode lazy images outside the initial viewport before a full-page capture.
  await page.evaluate(async () => {
    await Promise.all(Array.from(document.images, async (image) => {
      image.loading = "eager";
      await image.decode();
    }));
  });
  await page.screenshot({ path: join(screenshotDirectory, filename), fullPage, animations: "disabled" });
}

function monitorBrowser(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("requestfailed", (request) => errors.push(request.url() + " " + request.failure()?.errorText));
  return errors;
}

const sectionHeadings = [
  "Trending Stories", "Developing Stories", "Editor’s Picks", "Nigeria", "Africa", "World",
  "Featured intelligence reports", "Historical explainers",
];

test("desktop homepage renders its coverage and an article supports reading and bookmarking", async ({ page }) => {
  const errors = monitorBrowser(page);
  await page.setViewportSize({ width: 1440, height: 960 });
  expect((await page.goto("/"))?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "GeoLens AI news and intelligence" })).toBeAttached();
  await expect(page.getByText(/Breaking News/)).toBeVisible();
  await expect(page.getByText("Synthetic preview", { exact: true })).toBeVisible();
  for (const title of sectionHeadings) await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  expect(await page.locator("img").first().evaluate((image: HTMLImageElement) => image.decode().then(() => image.naturalWidth))).toBeGreaterThan(0);
  await screenshot(page, "desktop-home.png");

  await page.getByRole("link", { name: "Read the story" }).click();
  await expect(page.getByRole("heading", { name: "Lagos looks to the water for its next chapter", level: 1 })).toBeVisible();
  for (const heading of ["Quick Brief", "Deep Dive", "Historical background", "Timeline", "Source references", "Related stories"]) {
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
  await expect(page.getByText("Verification status")).toBeVisible();
  await expect(page.getByText(/Updated/)).toBeVisible();
  const timeline = page.locator("summary").first();
  await timeline.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("A fictional planning committee outlines transport and flood-protection priorities.")).toBeVisible();
  await screenshot(page, "desktop-article.png", true);

  const bookmark = page.getByRole("button", { name: "Bookmark", exact: true });
  await bookmark.click();
  await expect(page.getByText("Bookmark saved on this device.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Bookmarked" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Bookmarked" }).click();
  await expect(bookmark).toHaveAttribute("aria-pressed", "false");

  await page.evaluate(() => {
    Object.defineProperty(navigator, "share", { value: undefined });
    Object.defineProperty(navigator, "clipboard", { value: undefined });
  });
  await page.getByRole("button", { name: "Share" }).click();
  await expect(page.getByLabel("Article link")).toHaveValue(/\/articles\/lagos-waterfront$/);
  expect(errors).toEqual([]);
});

test.describe("mobile reader", () => {
  const { viewport, userAgent, hasTouch, isMobile } = devices["Pixel 7"];
  test.use({ viewport, userAgent, hasTouch, isMobile, deviceScaleFactor: 1 });

  test("menu, section filters and persistent dark theme work at a phone viewport", async ({ page }) => {
    const errors = monitorBrowser(page);
    await page.goto("/");
    const menu = page.getByRole("button", { name: "Menu" });
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await screenshot(page, "mobile-home.png");

    await menu.click();
    const africa = page.getByRole("navigation").getByRole("link", { name: "Africa", exact: true });
    await expect(africa).toBeVisible();
    await africa.focus();
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
    await expect(africa).toBeHidden();
    await menu.click();
    await africa.click();
    await expect(page.getByRole("heading", { name: "Africa", exact: true })).toBeVisible();
    await page.getByLabel("Content type").selectOption("Forecast");
    await page.getByRole("button", { name: "Apply filter" }).click();
    await expect(page).toHaveURL(/type=Forecast/);
    await expect(page.getByRole("heading", { name: /regional solar grid/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /West Africa’s ports/ })).toHaveCount(0);

    await page.getByRole("link", { name: /regional solar grid/ }).click();
    await expect(page.getByText("Forecast uncertainty")).toBeVisible();
    await page.getByRole("button", { name: "Toggle light or dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await screenshot(page, "mobile-article-dark.png", true);
    expect(errors).toEqual([]);
  });
});

test("search exposes loading and empty states while planned and unpublished content stay unavailable", async ({ page }) => {
  await page.goto("/search");

  // Slow one route-data request to exercise the visible loading state.
  let releaseRequest: () => void = () => {};
  const hold = new Promise<void>((resolve) => { releaseRequest = resolve; });
  await page.route(/\/search\.data\?/, async (route) => {
    await hold;
    await route.continue();
  });
  await page.getByLabel("Search stories").fill("  Solar Sahel");
  await page.getByLabel("Search stories").press("Enter");
  try {
    await expect(page.getByText("Loading…", { exact: true })).toBeVisible();
  } finally {
    releaseRequest();
  }
  await expect(page.getByText(/1 result for/)).toBeVisible();
  await expect(page.getByRole("heading", { name: /regional solar grid/ })).toBeVisible();

  await page.getByLabel("Search stories").fill("private-editorial-draft");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("No stories match these filters.")).toBeVisible();

  for (const path of ["/factcheck", "/ask", "/account"]) {
    expect((await page.goto(path))?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Unavailable in this preview" })).toBeVisible();
  }
  expect((await page.goto("/articles/private-editorial-draft"))?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to homepage" })).toBeVisible();
  expect((await page.goto("/section/nonexistent"))?.status()).toBe(404);
});


test("the reader offers recovery if route data cannot be loaded", async ({ page }) => {
  await page.goto("/");
  const worldData = /\/section\/world\.data(?:\?|$)/;
  await page.route(worldData, (route) => route.abort("failed"));
  await page.getByRole("navigation").getByRole("link", { name: "World", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
  await page.unroute(worldData);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "World", exact: true })).toBeVisible();
});
