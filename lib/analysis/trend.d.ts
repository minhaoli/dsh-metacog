/**
 * Trend computation over a window of contradiction observations.
 *
 * The spec forbids hand-writing `ContradictionNode.trend`: it must be derived
 * from the historical observation stream inside a configured window, or be
 * `unknown`. This module is the only place that decides a trend, and it works
 * purely from timestamps and intensities, so the verdict is reproducible and
 * auditable.
 *
 * A decision the callers must respect: **too few usable points is `unknown`,
 * never a guess**. Two observations a minute apart on a five-point ordinal
 * scale carry no trend, and reporting `stable` there would silently launder
 * noise into a monitoring conclusion.
 *
 * @module dsh-metacog/analysis/trend
 */
import type { ContradictionObservation, TrendDirection } from '../data/types.js';
/**
 * Minimum number of usable (non-null) observations needed before any direction
 * other than `unknown` is defensible.
 */
export declare const MIN_TREND_POINTS = 3;
/** How a trend was decided, so a tool result can explain itself. */
export interface TrendComputation {
    /** The verdict. */
    trend: TrendDirection;
    /** Usable points that entered the computation. */
    sampleSize: number;
    /** First and last intensity in the window, when both exist. */
    firstIntensity: number | null;
    lastIntensity: number | null;
    /** Net change `lastIntensity - firstIntensity`, when computable. */
    delta: number | null;
    /** Least-squares slope per observation step, when computable. */
    slope: number | null;
    /** Why this verdict, in one sentence. */
    rationale: string;
}
/**
 * Select the observations of one contradiction inside a window.
 *
 * @param observations - whole project stream, any order.
 * @param contradictionId - node to inspect.
 * @param windowMinutes - lookback in minutes from the newest usable point.
 * @param now - clock injection point for deterministic tests.
 * @returns observations oldest first, restricted to the window.
 */
export declare function observationsInWindow(observations: readonly ContradictionObservation[], contradictionId: string, windowMinutes: number, now?: Date): ContradictionObservation[];
/**
 * Compute the trend of a contradiction from its observation history.
 *
 * Rising/falling need both a real net move and a consistent least-squares
 * slope, so a single spike inside an otherwise flat series stays `stable`.
 *
 * @param observations - whole project stream.
 * @param contradictionId - node to inspect.
 * @param windowMinutes - lookback window.
 * @returns verdict plus the numbers behind it.
 */
export declare function computeTrend(observations: readonly ContradictionObservation[], contradictionId: string, windowMinutes: number): TrendComputation;
/**
 * Render a trend as the single arrow the report format uses.
 *
 * @param trend - computed direction.
 * @returns `↑`, `↓`, `→` or `?`.
 */
export declare function trendArrow(trend: TrendDirection): string;
