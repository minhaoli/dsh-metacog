/**
 * Minimum number of usable (non-null) observations needed before any direction
 * other than `unknown` is defensible.
 */
export const MIN_TREND_POINTS = 3;
/**
 * Select the observations of one contradiction inside a window.
 *
 * @param observations - whole project stream, any order.
 * @param contradictionId - node to inspect.
 * @param windowMinutes - lookback in minutes from the newest usable point.
 * @param now - clock injection point for deterministic tests.
 * @returns observations oldest first, restricted to the window.
 */
export function observationsInWindow(observations, contradictionId, windowMinutes, now = new Date()) {
    const mine = observations
        .filter((item) => item.contradictionId === contradictionId)
        .slice()
        .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
    if (mine.length === 0)
        return [];
    // The window is anchored to the newest observation, not to `now`: a stale
    // contradiction whose last observation is a week old still has a history
    // worth reading, and anchoring to `now` would silently return nothing.
    const newest = Date.parse(mine[mine.length - 1]?.observedAt ?? '') || now.getTime();
    const cutoff = newest - windowMinutes * 60_000;
    return mine.filter((item) => Date.parse(item.observedAt) >= cutoff);
}
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
export function computeTrend(observations, contradictionId, windowMinutes) {
    const window = observationsInWindow(observations, contradictionId, windowMinutes);
    const points = window
        .map((item, index) => ({ index, intensity: item.intensity }))
        .filter((item) => item.intensity !== null);
    if (points.length < MIN_TREND_POINTS) {
        return {
            trend: 'unknown',
            sampleSize: points.length,
            firstIntensity: points[0]?.intensity ?? null,
            lastIntensity: points[points.length - 1]?.intensity ?? null,
            delta: null,
            slope: null,
            rationale: `only ${points.length} usable observation(s) in the last ${windowMinutes} minutes; ` +
                `at least ${MIN_TREND_POINTS} are needed before a direction is claimable`,
        };
    }
    const first = points[0];
    const last = points[points.length - 1];
    // `points.length >= MIN_TREND_POINTS >= 3` guarantees both ends exist.
    const firstIntensity = first.intensity;
    const lastIntensity = last.intensity;
    const delta = lastIntensity - firstIntensity;
    const slope = leastSquaresSlope(points.map((item) => item.intensity));
    // Thresholds are asymmetric on purpose: intensity is an ordinal 1-5 judgment,
    // so anything short of a full point of net movement (or a slope that would not
    // cross a full point across the sample) is noise, not a trend.
    const RISING_DELTA = 1;
    const FALLING_DELTA = -1;
    const SLOPE_EPSILON = 0.2;
    let trend;
    if (delta >= RISING_DELTA && slope > SLOPE_EPSILON) {
        trend = 'rising';
    }
    else if (delta <= FALLING_DELTA && slope < -SLOPE_EPSILON) {
        trend = 'falling';
    }
    else {
        trend = 'stable';
    }
    const direction = trend === 'stable' ? 'no net movement' : `net ${trend}`;
    return {
        trend,
        sampleSize: points.length,
        firstIntensity,
        lastIntensity,
        delta,
        slope,
        rationale: `${points.length} observations in the last ${windowMinutes} minutes moved from ` +
            `${firstIntensity} to ${lastIntensity} (delta ${delta >= 0 ? '+' : ''}${delta}, ` +
            `slope ${slope.toFixed(2)}/step): ${direction}`,
    };
}
/**
 * Least-squares slope of a series against its index.
 *
 * @param values - the series, oldest first.
 * @returns slope in intensity units per observation step.
 */
function leastSquaresSlope(values) {
    const count = values.length;
    if (count < 2)
        return 0;
    const meanIndex = (count - 1) / 2;
    const meanValue = values.reduce((sum, value) => sum + value, 0) / count;
    let numerator = 0;
    let denominator = 0;
    for (const [index, value] of values.entries()) {
        const indexDelta = index - meanIndex;
        numerator += indexDelta * (value - meanValue);
        denominator += indexDelta * indexDelta;
    }
    return denominator === 0 ? 0 : numerator / denominator;
}
/**
 * Render a trend as the single arrow the report format uses.
 *
 * @param trend - computed direction.
 * @returns `↑`, `↓`, `→` or `?`.
 */
export function trendArrow(trend) {
    switch (trend) {
        case 'rising':
            return '↑';
        case 'falling':
            return '↓';
        case 'stable':
            return '→';
        default:
            return '?';
    }
}
