import { z } from "zod";

// Client4 interpolates identifiers and usernames directly into request URLs.
// Keep each value a literal segment so it cannot select a different API route.
export const routeSegment = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !/^\.+$/.test(value) &&
      !/[/\\%?#\s]/.test(value) &&
      [...value].every((character) => {
        const code = character.codePointAt(0);
        return code >= 32 && (code < 127 || code > 159);
      }),
    "must be a literal path segment without separators, escaping, or control characters",
  );
