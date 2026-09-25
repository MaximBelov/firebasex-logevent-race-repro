# Reproducing the `logEvent` / screen-reporter race in cordova-plugin-firebasex-analytics

A minimal Cordova app that reproduces the crash described in
[dpa99c/cordova-plugin-firebasex-analytics#5](https://github.com/dpa99c/cordova-plugin-firebasex-analytics/pull/5),
and a GitHub Actions workflow that reproduces it on every run: one job builds the
plugin as published today and expects it to crash, the other builds it with
PR #5 applied and expects it to survive. Both are checked automatically, so
the two green checkmarks on this repo *are* the evidence.

## The bug

`FirebasexAnalyticsPlugin.logEvent:` dispatches the `FIRAnalytics logEventWithName:parameters:`
call through `[self.commandDelegate runInBackground:...]`, which is Cordova's
**concurrent** global GCD queue -- so two `logEvent` calls can run on two
different threads at once.

That call is not just handing the event to the SDK's own worker queue. It
reaches `-[APMScreenViewReporter trackScreenWithParameters:timestamp:]`
**synchronously, on whatever thread called it**, to attach the current screen
to the event. Meanwhile Firebase's own automatic screen reporting writes that
same state from the main thread on every `viewDidAppear`, and this plugin's
own `setScreenName:` (not backgrounded) also writes it from whatever thread
Cordova's bridge calls plugin methods on -- the main thread. A `logEvent` call
arriving from a background queue races both of them.

[firebase/firebase-ios-sdk#6373](https://github.com/firebase/firebase-ios-sdk/issues/6373)
reports the same stack from the same cause (dispatching a screen-view event
from `DispatchQueue.global()`), and a Google engineer identified it as a
threading issue in the screen-view reporter. It was closed as stale in 2022
with no fix, so PR #5 fixes it on the caller's side instead: dispatch
`logEvent` to the main queue, matching what `setScreenName` already does.

## This reproduction

[`www/js/index.js`](www/js/index.js) fires a burst of 14,400 `logEvent` calls
(alternating `screen_view` events and plain custom events) interleaved with
7,200 `setScreenName` calls, all issued back-to-back with no delay between
them, starting one second after `deviceready`. No UI interaction, no real
Firebase project, no network dependency for the crash itself -- `deviceready`
is enough to trigger it.

## What I observed

Building the plugin as published (`2.0.2`) and running the burst crashes
reliably, in 1-5 seconds, every time I ran it. The uncaught-exception
backtrace lands squarely inside the method PR #5 changes, on a libdispatch
worker thread -- i.e. exactly the concurrent queue `runInBackground` hands it
to:

```
CoreFoundation               __exceptionPreprocess
libobjc.A.dylib               objc_exception_throw
CoreFoundation                +[NSObject(NSObject) instanceMethodSignatureForSelector:]
CoreFoundation                ___forwarding___
CoreFoundation                _CF_forwarding_prep_0
FirebasexLogEventRace.debug.dylib  APMScreenParameters
FirebasexLogEventRace.debug.dylib  -[APMAdExposureReporter handleScreenDidChangeFromScreen:toScreen:]
FirebasexLogEventRace.debug.dylib  -[APMScreenViewReporter postScreenDidChangeNotificationWithPreviousScreen:newScreen:]
FirebasexLogEventRace.debug.dylib  __61-[APMScreenViewReporter trackScreenWithParameters:timestamp:]_block_invoke.513
libdispatch.dylib             _dispatch_call_block_and_release
libdispatch.dylib             _dispatch_client_callout
libdispatch.dylib             _dispatch_lane_serial_drain
libdispatch.dylib             _dispatch_lane_invoke
libdispatch.dylib             _dispatch_root_queue_drain_deferred_wlh
libdispatch.dylib             _dispatch_workloop_worker_thread
libsystem_pthread.dylib       _pthread_wqthread
libsystem_pthread.dylib       start_wqthread
```

Full report: [`evidence/crash-report-unpatched.ips`](evidence/crash-report-unpatched.ips)
(readable with `python3 scripts/print-crash-summary.py <file>`, or open it in
Xcode's own crash viewer). To be precise about what this is and isn't: this is
`SIGABRT` from an uncaught `NSException` (a message sent to an object whose
memory a concurrent write had already stomped on), not the raw
`EXC_BAD_ACCESS`/`objc_retain` signature in PR #5's production report. Both
are what an unsynchronized data race on the same object looks like from the
outside -- which of the two you get depends on exactly what byte pattern the
race leaves behind, which isn't something either report can control. The
location is the same method, the same class, the same background-queue
caller.

Rebuilding with PR #5's one-line fix applied, the identical burst -- 14,400
`logEvent` calls, 7,200 `setScreenName` calls -- survives with zero errors.
Screenshot: [`evidence/screenshot-patched-survived.png`](evidence/screenshot-patched-survived.png).

## Run it yourself

Needs a Mac with Xcode and an iOS Simulator. Node 20+.

```bash
npm install

# reproduce the crash (plugin as published today)
npm run build:ios
npx cordova run ios --emulator

# or: build with the fix from PR #5 and watch it survive instead
npm run apply-fix
npm run build:ios
npx cordova run ios --emulator
```

The app starts the burst automatically one second after launch and updates
its own screen with progress; watch the Xcode/Simulator console, or just
watch whether the app is still running a minute later.

## CI

[`.github/workflows/reproduce.yml`](.github/workflows/reproduce.yml) builds
and runs both versions on a GitHub-hosted macOS runner on every push, and
fails the job if the outcome isn't the one expected -- so the "bug:
analytics@2.0.2 as published" job is expected to fail with a crash, and the
"fix: with PR #5 applied" job is expected to survive. Both jobs verify, via
`git hash-object` on the plugin source that actually reached the Xcode build,
exactly which version they built, and both attach a screenshot and a device
log as workflow artifacts. Check the [Actions tab](../../actions) for the
latest run.

One caveat: on GitHub's own runner, `ReportCrash` doesn't always get to
write a `.ips` file before the workflow looks for one (there's no logged-in
session for it to run under), so CI's proof of the crash is the job's
pass/fail outcome itself, not a freshly generated report every time. The
actual `.ips` in [`evidence/`](evidence/) is from a real local run, captured
the same way `npm run build:ios` + `cordova run ios --emulator` would give
you one.
