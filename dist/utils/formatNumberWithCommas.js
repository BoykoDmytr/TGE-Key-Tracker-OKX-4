/**
 * Format a numeric string with comma separators for thousands.
 * Preserves the decimal part (if any).
 *
 * Examples:
 *   "1000" -> "1,000"
 *   "2500000.50" -> "2,500,000.50"
 */
export function formatNumberWithCommas(x) {
    const [intPart, fracPart] = x.split('.');
    const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return fracPart ? `${withCommas}.${fracPart}` : withCommas;
}
