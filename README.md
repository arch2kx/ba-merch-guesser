# Blue Archive Merch Guesser

A small web game where you guess the price of Blue Archive merchandise.
Each round shows a real item listing. Type your guess in USD, and you'll
see the real price and how close you were. Five misses and the game ends.

## Features

- Real item listings and images from AmiAmi
- Prices converted from JPY to USD
- Guesses within 20% of the real price count as correct
- No repeated items until you've seen them all
- Global leaderboard (separate boards for standard and all-items modes)
- Safe mode by default, so no huge badonkers by default. You can always enable it if you want. (This was originally a school project.)

## How to Play

1. Look at the item and type how much you think it costs in USD.
2. Press *Submit* to see the real price.
3. Press *Next* for a new item.
4. Five wrong guesses ends the game. Press *Play Again* to start over.

## Running Locally

Requires [Bun](https://bun.sh).

    bun install
    bun build js/game.ts --outfile js/game.js

Then serve the folder with any static server (e.g. `bunx serve .`).

Without leaderboard config the game runs fully in the browser and the
leaderboard is hidden.

## Leaderboard Setup

The leaderboard runs on [Supabase](https://supabase.com). The server runs
the game: it picks items, grades guesses and keeps score, so the browser
never sends a score it could fake. Tables are locked down, and the browser
can only call three functions: `start_game`, `submit_guess` and
`get_leaderboard`. Saving a score goes through the `leaderboard-submit` edge
function, which checks the request's origin and an hCaptcha token before it
calls `submit_score` with the service role key. New games and leaderboard
entries are rate limited in the database.

1. Create a Supabase project.
2. In the SQL editor, run the files in `supabase/migrations/` in order, then
   `supabase/seed.sql`.
3. Put the project URL and anon/publishable key in `js/config.ts`, along with
   your hCaptcha sitekey.
4. Deploy the edge function and set its secrets:
   ```sh
   supabase link --project-ref <ref>
   supabase functions deploy leaderboard-submit
   supabase secrets set HCAPTCHA_SECRET=<secret> HCAPTCHA_SITEKEY=<sitekey> \
     ALLOWED_ORIGINS=https://arch2kx.github.io
   ```
5. Rebuild: `bun run build`.

When `js/baAmiData.json` changes, run `bun run seed` and run the new
`supabase/seed.sql` again.

If the server can't be reached, the game falls back to offline play and
scores aren't saved.

## Tests

    bun test

Runs the database migration against an in-memory Postgres (PGlite) and
checks gameplay, scoring and access rules.

## Notes

Prices are based on AmiAmi listings and a fixed exchange rate, so they
won't exactly match current prices.

Blue Archive is developed by NEXON Games and published by Nexon and Yostar.
This is an unofficial fan project and is not affiliated with or endorsed by
NEXON Games, Nexon, or Yostar. All Blue Archive characters, art, and product
images belong to their respective owners.
