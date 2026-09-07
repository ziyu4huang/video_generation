# Webhooks (research corpus 3/3)

Delivery is at-least-once; consumers must be idempotent. Retries back
off exponentially from 1s to 15m over 8 attempts, then the endpoint is
auto-disabled pending a manual re-verification ping.
