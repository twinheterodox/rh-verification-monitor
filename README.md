# RH / GRH Verification

The [live dashboard](https://twinheterodox.github.io/rh-verification-monitor/) follows an independent Lean check of Alpöge’s submission on the Riemann hypothesis and its Dirichlet generalization.

The build monitor samples three workers every minute. Its main counter counts each submitted module once across the pool. The verification stages show proof export and kernel replay separately.

During export, the dashboard shows bytes written, the write rate between observations, and a size history. The evidence panel records the final byte count and SHA-256 when fingerprinting finishes. During replay, the dashboard shows the active checker and the results for each pass. An approximate elapsed time uses the first or last observation when an exact process timestamp is unavailable. Checks deferred for physical RAM are labelled separately.

Stage and run clocks measure elapsed wall time from the recorded starts. During compilation, the estimated UTC finish projects the recent rate of distinct modules across the remaining inventory. Export and replay have no comparable work total.

The `telemetry` branch holds the [latest observation](https://raw.githubusercontent.com/twinheterodox/rh-verification-monitor/telemetry/status.json) and dated snapshots under `samples/YYYYMMDD/HHMM.json` (UTC). The dashboard reads those public copies. Each worker’s availability and activity figures refer to the time printed on the page.
