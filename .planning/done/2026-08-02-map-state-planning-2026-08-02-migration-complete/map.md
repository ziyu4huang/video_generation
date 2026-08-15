# Wayfinder map: 2026-08-02-map-state-planning-2026-08-02-migration-complete

## Destination

Map state — .planning/2026-08-02-migration-complete-end-to-end-recap-you-kicked-o/:                                                  
 - ✅ 01 per-name hardening · ✅ 02 drift-guard net · ✅ 03 deploy rollout                                                            
 - Frontier (unblocked): 04–12 (9 rollouts) + 13 (QA harness) + 14 (telemetry)                                                        
 - Blocked: 15 (delete hardcoded GATES) — waits on 02 + 03–12 + 13 + 14                                                               
 - Next pick: 04 — rollout file2md                                                                                                    
                                                                                                                                      
 Proven rollout pattern (04–12 repeat this):                                                                                          
 1. Read the extension's tools + its current GATES entry in tool-gate.ts.                                                             
 2. Owner-declare gating on each tool, mirroring the GATES entry (multi-name gate → same gating on each tool).                        
 3. Remove the entry from hardcoded GATES (+ CORE_TOOLS if present).                                                                  
 4. Append the extension to MIGRATED_EXTENSIONS in drift-guard.test.ts.                                                               
 5. qa/evaluate.ts already reconstructs migrated gates generically — corpus-covered tools just work.                                  
 6. Run tool-gate suite + the extension's own suite; close ticket + map bullet.                                                       
                                                                                                                                      
 Carry-forward findings (all documented in the map/tickets):                                                                          
 - enable_tool co-activation (map Not-yet-specified): migrating a multi-name gate splits it → enable_tool no longer co-activates      
   siblings (keyword/requires firing still does). Latent across all multi-name rollouts (file2md, workflow, krea2…).                  
 - qa reconstruction is a stopgap (ticket 13 note): reconstructOwnerDeclaredGates approximates; 13 still must swap for                
   buildEffectiveGates + restore 8 inspect probes.                                                                                    
 - telemetry undercount grows (ticket 14): each rollout widens the computeBannerSaved undercount — 14 gets more urgent.               
                                                                                                                                      
 To resume: load the map (wayfinder work-through), claim 04, and run the pattern above. The two prerequisites (hardening + net) are   
 in place, so the remaining 9 are mechanical.   

resume 04

## Notes

_(none)_

## Decisions so far

<!-- none yet -->

## Not yet specified

<!-- none -->

## Out of scope

<!-- none -->
