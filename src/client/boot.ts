/**
 * Entry point. `?spike=1` loads the band engine spike page (slice 1) instead of
 * the app, so the engine can be heard and tested on its own.
 */
if (new URLSearchParams(location.search).has("spike")) void import("./spike");
else void import("./main");
