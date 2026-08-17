## Question
Which responsibilities are duplicated ACROSS packages, and who should own each? Candidates to map: hermes knowledge-search-tool.ts (455) vs zk retrieve.ts; hermes card-store.ts (674) vs zk card-format/ingest; hermes semantic-search.ts (547) vs zk semantic.ts; sqlite×3 + corruption-recovery (~3.3k) vs surreal-default reality; obsidian's runSubagentWithRetry living in tier-0 vault I/O. Output: a who-could-delegate-to-whom map with LOC + edge-direction implications (no decisions — that's ticket 04).
type: research
blocked by: (none)
