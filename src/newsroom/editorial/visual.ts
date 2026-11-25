import { identity, visualRubricWeights } from "./types.ts";
import type { VisualAsset, VisualFactor, VisualInput, VisualQuality, VisualResult } from "./types";

export const visualQualityThreshold = 85;

export function containsActiveMarkup(value: string): boolean {
  return /<\s*(?:script|iframe|object|embed)\b|javascript\s*:/i.test(value);
}

export function containsPrivateContact(value: string): boolean {
  return /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/i.test(value);
}

function accurateVisual(asset: VisualAsset): boolean {
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

export function weightedVisualScore(ratings: VisualQuality["ratings"]): number {
  let weighted = 0;
  let applicableWeight = 0;
  for (const factor of Object.keys(visualRubricWeights) as VisualFactor[]) {
    const rating = ratings[factor];
    if (rating === null) continue;
    const weight = visualRubricWeights[factor];
    weighted += rating * weight;
    applicableWeight += weight;
  }
  return Math.round(weighted * 100 / applicableWeight) / 100;
}

export function assessVisual(asset: VisualAsset): VisualQuality {
  const hasEvidence = asset.evidenceIds.length > 0 && asset.documentIds.length > 0;
  const accurate = accurateVisual(asset) && hasEvidence && asset.snapshot?.dataDigest === asset.digest;
  const licensed = asset.licence.status === "active" && Boolean(asset.licence.reference.trim());
  const secure = !containsActiveMarkup(JSON.stringify(asset));
  const clarity = Boolean(asset.title?.trim()) && Boolean(asset.purpose?.trim()) && asset.caption.trim().length > 0
    && Array.from(asset.caption).length <= 180;
  const accessible = asset.alt.trim().length > 0 && Array.from(asset.alt).length <= 160;
  // The fixture uses the fixed GeoLens reader layout for every visual.
  const ratings: VisualQuality["ratings"] = {
    factual_and_data_accuracy: accurate ? 100 : 0,
    geographical_accuracy: asset.data.kind === "map" ? (accurate ? 100 : 0) : null,
    clarity: clarity ? 100 : 40,
    editorial_relevance: hasEvidence ? 100 : 0,
    accessibility: accessible ? 100 : 30,
    attribution_and_licensing: licensed ? 100 : 0,
    brand_consistency: 100,
  };
  const critical: VisualQuality["critical"] = [];
  if (!accurate) critical.push("accuracy");
  if (!licensed) critical.push("licensing");
  if (!secure) critical.push("security");
  return { ratings, score: weightedVisualScore(ratings), critical };
}

function clearsRubric(quality: VisualQuality): boolean {
  return quality.critical.length === 0 && quality.score >= visualQualityThreshold;
}

export function eligibleVisual(asset: VisualAsset): boolean {
  if (asset.snapshot) return clearsRubric(assessVisual(asset));
  return asset.licence.status === "active" && accurateVisual(asset);
}

export function assembleVisuals(input: VisualInput): VisualResult {
  const assets: VisualAsset[] = [];
  const blockedAssetIds: string[] = [];
  for (const asset of input.candidates) {
    if (input.qualityRubric === 1) {
      const quality = assessVisual(asset);
      if (clearsRubric(quality)) assets.push({ ...asset, quality });
      else blockedAssetIds.push(asset.id);
    } else if (eligibleVisual(asset)) assets.push(asset);
    else blockedAssetIds.push(asset.id);
  }
  return {
    ...identity(input), stage: "visual", assets, blockedAssetIds,
    layout: { responsive: true, foreground: "--ink", accent: "--accent", fallback: "text_and_data" },
  };
}
