# Auth flow (research corpus 1/3)

OAuth device flow starts at `/authorize/device`; the polling interval is
5 seconds and caps at 12 attempts before the session is discarded.
Tokens are rotated on every refresh; a stale refresh token returns 409.
