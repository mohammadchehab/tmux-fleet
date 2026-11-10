# Conformance

One suite per integration surface, run against every implementation of it. Cross-package by nature, so it lives here
rather than beside a package.

## providers/

Every provider package (`runtime/providers/{claude,deepinfra,…}`) must pass the same suite (§4): a session starts,
streams events in the shape `ProviderEvent` declares, reports usage, survives a kill and comes back with its identity
intact, and answers a typed `judge` question without the fleet having to parse prose.

Empty at phase 0 — `runtime/providers/sdk` is a skeleton. Phase 1 fills this as soon as the first provider exists.
