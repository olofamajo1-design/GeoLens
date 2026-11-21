import { identity } from "./types.ts";
import type { VisualAsset, VisualInput, VisualResult } from "./types";

export function eligibleVisual(asset: VisualAsset): boolean {
  if (asset.licence.status !== "active") return false;
  const { data } = asset;
  switch (data.kind) {
    case "map":
      return asset.provenance === "research_fixture" && asset.evidenceIds.length > 0
        && data.geojson.features.every(({ geometry, properties }) => {
          const [longitude, latitude] = geometry.coordinates;
          return Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90
            && (properties.accuracy !== "approximate" || /approximate/i.test(asset.uncertainty))
            && (properties.boundary !== "disputed" || /disputed/i.test(asset.uncertainty));
        });
    case "chart":
      return asset.provenance === "research_fixture" && asset.evidenceIds.length > 0
        && data.scale === "linear" && data.baseline === 0 && data.values.every(({ value }) => Number.isFinite(value) && value >= 0);
    case "timeline":
      return asset.provenance === "research_fixture" && asset.evidenceIds.length > 0
        && data.entries.every(({ startYear, endYear }) => startYear === null || endYear === null || startYear <= endYear);
    case "relationship":
      return asset.provenance === "research_fixture" && asset.evidenceIds.length > 0
        && data.links.every(({ from, to }) => from !== to && data.nodes.includes(from) && data.nodes.includes(to));
    case "infographic":
      return asset.provenance === "research_fixture" && asset.evidenceIds.length > 0;
    case "photo":
      return asset.provenance === "licensed_fixture" && data.disclosure === "Synthetic licensed media fixture";
    case "illustration":
      return asset.provenance === "mock_ai" && data.disclosure === "AI-generated synthetic illustration";
  }
}

export function assembleVisuals(input: VisualInput): VisualResult {
  const assets: VisualAsset[] = [];
  const blockedAssetIds: string[] = [];
  for (const asset of input.candidates) {
    if (eligibleVisual(asset)) assets.push(asset);
    else blockedAssetIds.push(asset.id);
  }
  return {
    ...identity(input), stage: "visual", assets, blockedAssetIds,
    layout: { responsive: true, foreground: "--ink", accent: "--accent", fallback: "text_and_data" },
  };
}
