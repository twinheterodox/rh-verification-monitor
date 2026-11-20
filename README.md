# RH / GRH Verification

The [live dashboard](https://twinheterodox.github.io/rh-verification-monitor/) follows an independent Lean check of Alpöge’s submission on the Riemann hypothesis and its Dirichlet generalization.

The build monitor samples three workers every four minutes. Its main counter counts each submitted module once across the pool. The verification stages show proof export and kernel replay separately.

Stage and run clocks measure elapsed wall time from the recorded starts. During compilation, the estimated UTC finish projects the recent rate of distinct modules across the remaining inventory. Export and replay have no comparable work total.

The `telemetry` branch holds the [latest observation](https://raw.githubusercontent.com/twinheterodox/rh-verification-monitor/telemetry/status.json) and its sample history. The dashboard reads that public copy. The stated availability of a worker and its activity figures refer to the time printed on the page.
