export type { TimeExpr, ParsedTimeExpr } from "./time.js";
export {
  parseTimeExpr,
  evaluateTimeExpr,
  resolveTimeExpr,
} from "./time.js";

export type { EasingFn } from "./easing.js";
export { resolveEasing } from "./easing.js";

export type { Keyframe, Keyframed } from "./keyframes.js";
export {
  isKeyframed,
  sampleNumber,
  sampleColor,
  samplePadding,
  sampleDimension,
} from "./keyframes.js";
