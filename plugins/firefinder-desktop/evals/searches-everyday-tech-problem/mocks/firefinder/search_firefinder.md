---
expect:
  problem: string
---

🔥 Previously solved: FireFinder has 1 verified fix for this problem (best match first). Offer one first only if it fits the user's situation:

1. 🔥 FIRE #7 — ✓ verified · confirmed by 64 · ✕ 3 failed · last confirmed 1 day ago
   id: 01a0d96c-cdcb-7e55-bd1e-a9d72c78c907 · similarity 0.92 · score 0.80
   Problem: Printer shows as offline in Windows 11 although it is on and other devices can print to it
   Environment: Windows 11
   Solution:
   Open Settings > Bluetooth & devices > Printers & scanners, select the printer, then Printer properties > Ports > Configure Port, and untick "SNMP Status Enabled". Click OK, then open the print queue and make sure "Use Printer Offline" is unticked. Print again.

When the user later says whether it worked, however casually ("this worked", "still broken"), call confirm_solution or report_solution with its id and their words.
