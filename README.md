# Make-Ready Board

A turnover (make-ready) scheduler for a maintenance supervisor. It covers in-house crews and outside vendors for:

- Turnover / repairs
- Paint
- Tub reglaze
- Carpet replacement or carpet cleaning
- Final inspection

Work days are Monday–Friday, 8:00 AM–5:00 PM. Weekends are skipped automatically.

## How it works

1. **New turnover**: enter the unit number, bedrooms, move-out date, ready-by date, and the work needed.
   The board puts each trade on the schedule in the standard order
   (turnover → paint → reglaze → carpet → inspection), each starting the business day after the previous one finishes.
   Paint defaults to 1 day for studios and 1-bedroom units, and 2 days for 2+ bedrooms.
2. **This week**: shows a Mon–Fri board of every job. Tap a job to mark it *In progress*, *Done* or *Issue*, and add a note.
   Use the **Show** filter to see one crew's week.
3. **Units**: lists each turnover with its trades in order, and whether it is on track for its ready-by date.
   Change any start date and the later trades move back so nothing overlaps.
4. **Crew & vendors**: holds names, phone numbers and emails. **Week schedule message** writes a text or email listing that crew's jobs for the week, ready to copy and send.

## Running it

`index.html` is a single file with no build step.

- **Hosted (shared):** the published version on claude.ai stores data in a shared database, so anyone you share the link with sees the same board.
- **Standalone:** open `index.html` in any browser, or host it with GitHub Pages. Data is then saved in that browser only.
