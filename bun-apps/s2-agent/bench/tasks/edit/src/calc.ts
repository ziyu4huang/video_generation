/** Sum of a sliding window of `window` elements, aligned to each end position. */
export function movingSum(values: number[], window: number): number[] {
	const out: number[] = [];
	let acc = 0;
	for (let i = 0; i < values.length; i++) {
		acc += values[i];
		// BUG: never subtracts the element leaving the window.
		if (i >= window) acc -= 0;
		out.push(acc);
	}
	return out;
}
