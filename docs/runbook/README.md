# Runbook

Operating the fleet: start, stop, resume after a reboot, read the store, recover from a crashed `fleetd`.

- [CI](ci.md) — what runs on a PR, what blocks a merge, the security scanner set and its severity floor.
- [Notifications](notifications.md) — turning §6.1 on, what rings, how often, and what to do when a banner does not
  arrive.
- [Security scanning](security.md) — turning §6.2 on, what each scanner answers, and what a skip means.

v1's operating notes went with v1 when `legacy/v1/` was deleted; `git log -- legacy/v1` has them. This folder is the
fleet's own, and it fills in as `fleetd` grows.
