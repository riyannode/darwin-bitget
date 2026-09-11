# EVA Integration

EVA is an optional external adversarial evaluator. It may submit scenarios and bounded observable feedback through an isolated adapter boundary.

EVA owns its own weakness memory. The trader owns its own lesson memory. Neither adapter may bypass `risk-gate.ts`, and this repository does not modify the EVA repository.
