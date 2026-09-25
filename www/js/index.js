/**
 * Fires a large burst of concurrent FirebasexAnalytics calls to reproduce the
 * logEvent/screen-reporter race described in
 * https://github.com/dpa99c/cordova-plugin-firebasex-analytics/pull/5
 *
 * - logEvent() is dispatched by the plugin via runInBackground, i.e. Cordova's
 *   *concurrent* global GCD queue, and reaches FIRAnalytics logEventWithName:,
 *   which touches the SDK's screen-reporter state synchronously on whatever
 *   thread called it.
 * - setScreenName() is NOT backgrounded, so it runs on the thread the Cordova
 *   bridge already calls plugin methods on (the main thread) -- the same
 *   thread Firebase's own automatic screen reporting uses.
 *
 * Firing enough of both concurrently reproduces the torn-pointer crash
 * (EXC_BAD_ACCESS in objc_retain, inside APMScreenViewReporter) within a few
 * seconds on the unpatched plugin, and survives indefinitely once logEvent()
 * is moved to the main queue (the one-line fix in PR #5).
 */
document.addEventListener('deviceready', onDeviceReady, false);

var state = {
    logEventCalls: 0,
    setScreenNameCalls: 0,
    errors: 0
};

var TOTAL_ROUNDS = 120;
var CALLS_PER_ROUND = 60;
// 120 * 60 * 2 = 14,400 logEvent calls, 120 * 60 = 7,200 setScreenName calls.

function setStatus(text) {
    var el = document.getElementById('status');
    if (el) el.textContent = text;
}

function onDeviceReady() {
    setStatus('deviceready fired -- starting burst in 1s');
    // Let the automatic screen_view event from app launch settle first.
    setTimeout(startStress, 1000);
}

function startStress() {
    var round = 0;

    function fireRound() {
        for (var i = 0; i < CALLS_PER_ROUND; i++) {
            var n = round * CALLS_PER_ROUND + i;

            // "Write" side: a screen_view event through logEvent().
            FirebasexAnalytics.logEvent(
                'screen_view',
                { screen_name: 'BurstScreen' + (n % 7), screen_class: 'BurstClass' + (n % 7) },
                function () { state.logEventCalls++; },
                function () { state.errors++; }
            );

            // "Read" side: an ordinary custom event, same runInBackground path.
            FirebasexAnalytics.logEvent(
                'stress_event',
                { n: n },
                function () { state.logEventCalls++; },
                function () { state.errors++; }
            );

            // Main-thread side: not backgrounded, races the two calls above.
            FirebasexAnalytics.setScreenName(
                'MainThreadScreen' + (n % 7),
                function () { state.setScreenNameCalls++; },
                function () { state.errors++; }
            );
        }

        round++;
        setStatus(
            'round ' + round + '/' + TOTAL_ROUNDS + '\n' +
            'logEvent calls issued: ' + (round * CALLS_PER_ROUND * 2) + '\n' +
            'setScreenName calls issued: ' + (round * CALLS_PER_ROUND) + '\n' +
            'completions so far -- logEvent: ' + state.logEventCalls +
            ', setScreenName: ' + state.setScreenNameCalls +
            ', errors: ' + state.errors
        );

        if (round < TOTAL_ROUNDS) {
            setTimeout(fireRound, 0);
        } else {
            setStatus(
                'SURVIVED\n' +
                'Issued ' + (TOTAL_ROUNDS * CALLS_PER_ROUND * 2) + ' logEvent calls and ' +
                (TOTAL_ROUNDS * CALLS_PER_ROUND) + ' setScreenName calls with no crash.\n' +
                'completions -- logEvent: ' + state.logEventCalls +
                ', setScreenName: ' + state.setScreenNameCalls +
                ', errors: ' + state.errors
            );
        }
    }

    fireRound();
}
