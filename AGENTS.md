# Project instructions

Read `docs/implementation.md` before changing Pi lifecycle or transport integration.

Pi 1.4.0 clears the active abort signal before `agent_before_settle`. Run isolated repair at `turn_end` and keep settlement free of awaited model work. Preserve cancellation cleanup at the turn boundary because aborted runs can skip final settlement.
