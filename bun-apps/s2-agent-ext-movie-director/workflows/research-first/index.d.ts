// Type-only companion for the Bun text import in
// extensions/movie-workflows.ts. The runtime loads the raw index.js source as a
// string via `with { type: "text" }`; this declaration types that string as the
// module's default export. Does not affect the bundled script contents.
declare const source: string;
export default source;
