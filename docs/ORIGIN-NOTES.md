# Architecture notes

Orbit Agent is an independent, dependency-free portfolio project. Its design
focuses on a small set of explicit boundaries that are easy to inspect and
replace:

- stable Agent identities;
- thread/message continuity;
- explicit mention routing;
- serial and parallel execution;
- bounded memory recall;
- capability allow-listing;
- durable event traces.

The runtime keeps provider and storage integrations behind local interfaces so
the core workflow remains deterministic and easy to run on a fresh checkout.
