import type { Child } from "../types.js";

/**
 * Distribute flex budget across children.
 * Returns target durations for each child.
 */
export function distributeFlex(
  children: Child[],
  naturals: number[],
  totalGap: number,
  containerDuration: number
): number[] {
  const flexBudget =
    containerDuration -
    totalGap -
    children.reduce((sum, child, i) => {
      const flex = child.type === "empty" ? child.flex : child.flex;
      return flex ? sum : sum + naturals[i];
    }, 0);

  const totalFlex = children.reduce((sum, child) => {
    const flex = child.type === "empty" ? child.flex : child.flex;
    return sum + (flex ?? 0);
  }, 0);

  const flexUnit = totalFlex > 0 ? flexBudget / totalFlex : 0;

  return children.map((child, i) => {
    const flex = child.type === "empty" ? child.flex : child.flex;
    if (flex) {
      return flexUnit * flex;
    }
    return naturals[i];
  });
}
