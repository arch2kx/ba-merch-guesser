# Blue Archive Merch Guesser

A small web game where you guess the price of Blue Archive merchandise.
Each round shows a real item listing. Type your guess in USD, and you'll
see the real price and how close you were. Five misses and the game ends.

## Features

- Real item listings and images from AmiAmi
- Prices converted from JPY to USD
- Guesses within 20% of the real price count as correct
- No repeated items until you've seen them all

## How to Play

1. Look at the item and type how much you think it costs in USD.
2. Press *Submit* to see the real price.
3. Press *Next* for a new item.
4. Five wrong guesses ends the game. Press *Play Again* to start over.

## Running Locally

Requires [Bun](https://bun.sh).

    bun install
    bun build js/game.ts --outfile js/game.js

Then open `index.html` in a browser, or serve the folder with any static
server.

## Notes

Prices are based on AmiAmi listings and a fixed exchange rate, so they
won't exactly match current prices.

Blue Archive is developed by NEXON Games and published by Nexon and Yostar.
This is an unofficial fan project and is not affiliated with or endorsed by
NEXON Games, Nexon, or Yostar. All Blue Archive characters, art, and product
images belong to their respective owners.
