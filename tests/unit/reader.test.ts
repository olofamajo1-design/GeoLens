import { describe, expect, it } from "vitest";
import { coverage, findStories, getStory, storyCards } from "../../src/reader/catalogue.server";

describe("public synthetic catalogue", () => {
  it("resolves every homepage selection to public records", () => {
    for (const group of coverage) expect(storyCards(group.slugs)).toHaveLength(group.slugs.length);
  });

  it("searches case-insensitively across headline, geography and type", () => {
    expect(findStories({ query: "  SolaR   sahel " }).map(({ slug }) => slug)).toEqual(["sahel-solar-grid"]);
    expect(findStories({ query: "international analysis" }).map(({ slug }) => slug)).toEqual(["diplomacy-table"]);
  });

  it("intersects section and content-type filters", () => {
    expect(findStories({ section: "africa", type: "Forecast" }).map(({ slug }) => slug)).toEqual(["sahel-solar-grid"]);
    expect(findStories({ section: "nigeria", type: "Forecast" })).toEqual([]);
  });

  it("keeps unpublished slugs outside lookup and search", () => {
    expect(getStory("private-editorial-draft")).toBeUndefined();
    expect(storyCards(["private-editorial-draft"])).toEqual([]);
    expect(findStories({ query: "private-editorial-draft" })).toEqual([]);
  });
});
