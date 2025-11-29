# Verification Checklist

Use this guide to validate the new high-performance architecture before promoting a build.

1. **Native messaging host**
   - Install the `relay.auto.daemon` manifest on the AWS worker and start the daemon.
   - Open the popup and ensure the status string reads `native:on`; if it shows `native:off`, inspect `chrome://extensions` → *Errors* for host connection failures.
   - Trigger `Start` and watch the devtools console; successful native requests show `[Native]` log lines from the service worker.

2. **SSE wakeups**
   - From the popup *Options…* link, set `SSE Endpoint` if you need a non-default stream, then reload the extension.
   - Open the Relay load board tab; the floating overlay should display `sse:on` within a few seconds. Disconnecting the network should flip it to `sse:off` after the next retry.

3. **Background poller**
   - With the overlay showing `native:on · sse:on`, hit `Alt+R` to start polling. Observe `polls:*` metrics updating without visible tab jank.
   - When a result arrives, confirm `POLL_RESULTS` logs in `chrome://serviceworker-internals` and that the popup status string reflects `running`.

4. **Booking path**
   - Enable `Stop on first load`, ensure `autoBookFirst` remains `true`, and verify the overlay transitions to `BOOKED` after the daemon books the load.
   - If booking fails, the overlay logs `booking failed` and the popup status reverts to `idle`; collect the service-worker stack trace before retrying.
