# Rate limits (research corpus 2/3)

Default quota is 120 requests/minute per key, burst 20. Sustained
over-limit callers receive 429 with `Retry-After`; the third 429 in a
rolling minute escalates the key to a 60-second cooldown.
