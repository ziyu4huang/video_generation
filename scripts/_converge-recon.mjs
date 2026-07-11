import { readFileSync } from "node:fs";
import { homedir } from "node:os";
const HM = homedir() + "/.pi/agent/pi-hermes-memory";
const DELIM = "\n§\n";
const files = { failure: "failures.md", memory: "MEMORY.md", user: "USER.md" };
const state = JSON.parse(readFileSync(HM + "/.vault-converge-state.json", "utf8"));
function stripMeta(e){const m=e.match(/^(.*?)\s*<!--\s*created=([^,]+),\s*last=([^>]+)\s*-->\s*$/);return m?m[1].trim():e.trim();}
function hash(e){let h=5381;for(let i=0;i<e.length;i++)h=((h<<5)+h+e.charCodeAt(i))|0;return(h>>>0).toString(36);}
function dedupNorm(e){return stripMeta(e).trim().replace(/\s+/g," ");}
function dedup(entries){const seen=new Map();for(const e of entries){const k=dedupNorm(e);const ex=seen.get(k);if(!ex||e.length>ex.length)seen.set(k,e);}return[...seen.values()];}
let totConv=0,totAll=0;
console.log("target   total  converged  unconverged  rate");
for(const[t,f]of Object.entries(files)){
  const raw=readFileSync(HM+"/"+f,"utf-8");
  const entries=raw.split(DELIM).map(e=>e.trim()).filter(Boolean);
  const dd=dedup(entries);
  const hashes=new Set(state[t]??[]);
  let conv=0;for(const e of dd){if(hashes.has(hash(stripMeta(e))))conv++;}
  const unconverged=dd.length-conv;
  const rate=dd.length?(conv/dd.length*100).toFixed(0)+"%":"-";
  totConv+=conv;totAll+=dd.length;
  console.log(`${t.padEnd(9)} ${String(dd.length).padStart(5)}  ${String(conv).padStart(8)}  ${String(unconverged).padStart(11)}  ${rate}`);
}
console.log("-".repeat(48));
console.log(`TOTAL     ${String(totAll).padStart(5)}  ${String(totConv).padStart(8)}  ${String(totAll-totConv).padStart(11)}  ${(totConv/totAll*100).toFixed(0)}%`);
