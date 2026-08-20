#!/usr/bin/env bash
# Adversarial proof: semantic (vault-mind /api/search) vs lexical (ripgrep substring).
# For each query, show what each retrieval mode finds over the 425-card s2-agent-vault.
# A query phrased in natural language that shares NO words with a card's title/keywords
# is the canonical "semantic beats lexical" case.
set -uo pipefail

VAULT_PATH="/Users/huangziyu/proj/video_generation__pi/vaults_root/s2-agent-vault"
VAULT_NAME="s2-agent-vault"
VM_BASE="${VAULT_MIND_BASE_URL:-http://127.0.0.1:8000}"
OUT_DIR="$(git rev-parse --show-toplevel)/output/vault-mind-bridge-proof"
mkdir -p "$OUT_DIR"

PY="$(command -v python3)"

# Queries engineered so the user's wording diverges from the card vocabulary.
# (card vocab in parentheses; the query avoids it on purpose)
QUERIES=(
  "how do I avoid the gpu exploding on big images|oom|MemoryError|seedvr2|fp8"
  "the model output looks fake and shiny like plastic|plasticky|CFG|zimage"
  "switching git branches broke my downloaded model weights|submodule|vendor|symlink"
  "agent keeps producing the same wrong answer and cannot improve|self-improve|plateau|loop"
)

lex_search() {  # $1 = query -> prints matching file basenames (substring, case-insensitive)
  local q="$1"
  rg -l -i -F "$q" "$VAULT_PATH" 2>/dev/null \
    | sed "s#$VAULT_PATH/##" | sort -u || true
}

sem_search() {  # $1 = query -> prints "score|filename|snippet"
  local q="$1"
  curl -sG "$VM_BASE/api/search" \
    --data-urlencode "vault_name=$VAULT_NAME" \
    --data-urlencode "query=$q" \
    --data-urlencode "limit=5" \
    --data-urlencode "similarity_threshold=0.15" \
    | "$PY" -c "
import sys, json
try:
    data = json.load(sys.stdin).get('data', {})
except Exception as e:
    print(f'  (semantic error: {e})'); sys.exit()
print(f'  total_found={data.get(\"total_found\")} time_ms={round(data.get(\"search_time_ms\",0),1)}')
for r in (data.get('results') or [])[:5]:
    meta = r.get('metadata', {})
    fp = meta.get('file_path', meta.get('source_file','?'))
    name = fp.split('/')[-1]
    snip = (r.get('content','') or '')[:80].replace(chr(10),' ')
    print(f'    [{r.get(\"similarity_score\",0):.3f}] {name}')
    print(f'         » {snip}')
"
}

{
  echo "# vault-mind bridge — semantic vs lexical adversarial proof"
  echo
  echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Vault: \`$VAULT_NAME\` ($VAULT_PATH)"
  echo "Semantic backend: \`$VM_BASE/api/search\` (all-MiniLM-L6-v2, 384-dim, ChromaDB)"
  echo "Lexical baseline: \`rg -i -F <query>\` (substring = obsidian_search lexical mode)"
  echo
  for entry in "${QUERIES[@]}"; do
    q="${entry%%|*}"; cardvocab="${entry#*|}"
    echo "## Query"
    echo "> \`$q\`"
    echo
    echo "(card vocabulary the query deliberately avoids: \`$cardvocab\`)"
    echo
    echo "### Lexical (substring)"
    local_hits="$(lex_search "$q")"
    if [ -z "$local_hits" ]; then
      echo "**0 hits** — natural-language phrasing shares no token with any card."
    else
      echo '```'
      echo "$local_hits"
      echo '```'
    fi
    echo
    echo "### Semantic (vector)"
    sem_search "$q"
    echo
  done
} | tee "$OUT_DIR/proof.md"

echo
echo "Saved → $OUT_DIR/proof.md"
