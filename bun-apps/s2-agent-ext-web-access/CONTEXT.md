# s2-agent-ext-web-access

The ubiquitous language of s2-agent-ext-web-access — web access for Pi: multi-provider search, content extraction (URL / YouTube / GitHub / video), and a browser-curator fallback for bot-blocked sites. Eight search providers behind one unified interface, with SSRF protection on every fetch.

## Language

### The three tools

**web_search**:
Multi-provider search returning an AI-synthesized answer with source citations. Prefers `queries[]` (2–4 varied angles) over a single `query` for coverage; auto-opens an interactive browser curator.
_Avoid_: google, search API (it is a unified multi-provider synthesized-answer search)

**fetch_content**:
Extracts readable markdown from URL(s) — web pages, YouTube transcripts (+ frame extraction), GitHub repo contents, local video files. Falls back to Gemini for pages that block bots or fail Readability.
_Avoid_: scrape, download (it is readable-content extraction across URL / YouTube / GitHub / video)

**get_search_content**:
Retrieves the full stored content from a prior `web_search` or `fetch_content` by `responseId` (or query/url selector) — content is always stored, retrieved on demand.
_Avoid_: cache lookup, history (it is responseId-keyed retrieval of prior search/fetch content)

### Providers

**Provider auto-selection**:
The provider chain — Z.ai first (preferred, when its key is set), then OpenAI, Exa, Brave, Parallel, Tavily, Perplexity, Gemini API, then Gemini Web. Override with the `provider` param.
_Avoid_: provider list, fallback (it is an ordered auto-selection chain)

**Multi-query** (`queries` over `query`):
The coverage guidance — pass 2–4 queries with varied phrasing / scope / angle instead of one; each gets its own synthesized answer. Better than near-duplicate variants.
_Avoid_: batch search, multi-search (it is the varied-angle multi-query pattern, not a batch)

### The curator

**Browser curator**:
The interactive layer that opens when search runs — curation of results with three workflow modes: `none` (skip), `summary-review` (curator + auto summary draft), `auto-summary` (summary without the curator).
_Avoid_: browser fallback, headless browser (it is the interactive curation layer with workflow modes)

### Security

**SSRF guards**:
Every fetch validates protocol + hostname (DNS-rebinding defense, loopback / IPv6 block) before any request — blocks the server-side-request-forgery class on URL fetching.
_Avoid_: validation, network filter (it is the SSRF protection layer on fetch)
