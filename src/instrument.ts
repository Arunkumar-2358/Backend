/** Imported first by every entry point so Sentry can instrument modules as they load. */
import * as Sentry from "@sentry/node";
import { maskPii, maskPiiDeep } from "./lib/pii-scrub";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    release: process.env.RELEASE_SHA,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    // Candidate PII must never leave the system: strip request bodies, cookies and auth headers.
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        if (event.request.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
        if (event.request.query_string) event.request.query_string = "[redacted]";
      }
      // Error messages can quote input ("Invalid mobile 98…"): mask contact details everywhere text travels.
      if (event.message) event.message = maskPii(event.message);
      for (const ex of event.exception?.values ?? []) if (ex.value) ex.value = maskPii(ex.value);
      if (event.extra) event.extra = maskPiiDeep(event.extra);
      delete event.user;
      return event;
    },
    beforeBreadcrumb(b) {
      if (b.category === "console") return null;
      if (b.message) b.message = maskPii(b.message);
      if (b.data) b.data = maskPiiDeep(b.data);
      return b;
    },
  });
}
