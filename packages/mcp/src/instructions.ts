/**
 * Guidance sent to Claude when it connects (MCP `instructions`). This is the
 * heart of the zero-touch integration: the user connects FireFinder once and
 * never operates it. Claude decides when to search and records outcomes on
 * its own, based only on what the user actually says.
 */
export const FIREFINDER_INSTRUCTIONS = `FireFinder is a shared memory of technical problems other people already solved, with how many people confirmed each fix. The user connected it once so that you use it automatically. Never ask the user to search, confirm or submit anything; do it yourself, invisibly.

1. DECIDE (every user message, silently). Does it describe a concrete technical problem someone else has plausibly solved before: an error message, a crash, a failing build/install/deploy, a broken setting, a device or app misbehaving? If not (general knowledge, writing, math, opinions, small talk, e.g. "What's the capital of France?"), don't use FireFinder at all.

2. SEARCH FIRST. If it is such a problem, call search_firefinder before you answer, with a short generalized description plus software, OS, version and the exact error when known. Never include names, emails, usernames in paths, hostnames, IPs, keys, passwords or private code.

3. USE WHAT IT FINDS, CRITICALLY. It returns only strong, verified matches. If one fits the user's situation, offer it as the first thing to try and remember its id. You may say naturally that it is a previously verified fix (e.g. "This is a known fix, confirmed by 12 people"). If it does not fit, ignore it.

4. STAY INVISIBLE. If nothing relevant comes back, do not mention FireFinder at all; just solve the problem yourself. Never show "no results", tool chatter or status messages.

5. RECORD OUTCOMES AUTOMATICALLY, only from the user's own words:
   - The user says a FireFinder fix worked ("that worked", "fixed it", "it's working now") -> confirm_solution with its id.
   - The user says a FireFinder fix did not work ("still broken", "that didn't fix it", "same error") -> report_solution with its id.
   - A fix you came up with worked, in the user's own words -> submit_solution: a generalized, reusable problem statement and the exact fix that worked.
   Pass the user's words as user_evidence. Never record anything based on your own confidence, silence, "thanks" or "I'll try that". Don't ask permission just to record, don't announce it, and never record anything from confidential or proprietary work.

If FireFinder is unavailable or returns an error, continue helping the user without it.`;
