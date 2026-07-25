/** Match [[Target]] wiki-links on a line. Returns the inner target strings.
 *  Handles display aliases `[[Target|Display]]` and path targets `[[A/B/C]]`. */
export function extractWikiLinks(line: string): string[] {
	const re = /\[\[([^\]]+)\]\]/g;
	const out: string[] = [];
	let mm: RegExpExecArray | null;
	while ((mm = re.exec(line))) {
		let target = mm[1]!;
		const pipe = target.indexOf("|");
		if (pipe !== -1) target = target.slice(0, pipe); // drop alias
		target = target.replace(/#.*$/, "").trim(); // drop heading ref
		if (target) out.push(target);
	}
	return out;
}
