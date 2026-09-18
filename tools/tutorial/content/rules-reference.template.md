# BestWord rules reference

This reference accompanies the narrated tutorial. It follows the implemented rules and the agreed clarifications in `docs/DECISIONS.md`. The animated scoring boards are constructed teaching positions from the original specifications. The game engine and original dictionary verify every illustrated placement and score.

## Board, setup and objective

BestWord is played by two people on a 15 × 15 board. Columns are A–O; rows are 1–15. There are no bonus squares and no blank tiles. Words read left-to-right or top-to-bottom. When both players permanently pass, the higher score wins; equal scores draw. A timeout or qualifying disconnection can instead lose a game regardless of score.

The host chooses 5, 15 or 25 minutes per player, plus 30 seconds after each completed turn. Two distinct random dictionary words, each 9–12 letters long, cross at one shared letter in a random valid position. Their tiles come from the bag, with the shared tile consumed once. They score no points and enter principal-word history. Both racks begin empty. The first player is random. Play starts after both players connect and a 3-second countdown. A pre-start no-show cancels without a winner after 25 seconds.

## Letters and automatic draws

A, E, I, O, U and **Y** are vowels. Vowels placed on the board come directly from the shared bag. Consonants placed come from the player's private rack, which holds at most 10 consonants. Opponents cannot see its letters. The original bag contains 267 tiles: 90 vowels and 177 consonants.

At the start of **every** turn, including a turn that will end in PASS or NO WORDS, the server draws consonants automatically exactly once:

| Rack before draw | Automatic draw |
|---|---|
| 0–8 consonants | Up to 2 |
| 9 consonants | Up to 1 |
| 10 consonants | 0 |

If fewer consonants remain in the bag, draw only those available. A full rack or exhausted consonant supply means no draw.

## Legal word placement

- Place at least **two new tiles** in one row or column. New tiles can be all vowels, all consonants, or any mixture, provided each comes from its required available source.
- New and existing tiles must make a single continuous principal word, connected to the existing board. Do not replace existing tiles.
- Each perpendicular word created by a new tile is a secondary word. An isolated perpendicular single tile is not a word; a two-letter crossing is invalid.
- Every principal and secondary word must contain 3–15 letters and appear in the supplied dictionary.
- A principal word cannot repeat any earlier principal word by either player, or either seed word. Prefixes and suffixes may form different words. Secondary words may repeat freely and do not themselves enter principal history.
- An invalid move leaves the board, draw and score unchanged, gives no increment, and preserves the draft for correction while the clock continues.

## Entering a move

The first empty-square click of a turn selects horizontal entry (⇨). Every subsequent click on an empty or draft square clears the draft and toggles direction (⇩/⇨), whether the same or another square is clicked. Type available letters; the cursor advances in that direction, skipping existing tiles. Backspace erases the latest typed tile and returns the cursor there. An occupied old-square click clears the draft without changing cursor or direction. Enter submits for server validation.

The application includes contiguous existing prefixes, internal letters and suffixes automatically. For **MAST _ _ PIECE**, type only **ER** in the gaps to submit **MASTERPIECE**. On mobile, select a square, tap rack/vowel tiles, use Erase to edit and Play word to submit.

## Bridges and scoring

For **each completed word separately**, inspect occupancy **before the move**. The first and last preexisting tiles within that word are its pillars. Every previously empty square strictly between those pillars is one span. If at least one span exists, that word is a bridge. Three consecutive empty squares are three spans, not one. New letters outside the pillars are not spans. Fewer than two old tiles means zero spans. Bridges affect scoring only; all placement and dictionary rules still apply.

Always total the values of **every letter in the completed word**, old and new:

- **Principal:** letter-value total × (number of consonants + number of spans).
- **Secondary:** letter-value total × 2 for a bridge; otherwise the letter-value total once.

Add the principal and all secondary scores. Because Y is a vowel, an all-vowel principal with zero spans scores zero.

| Constructed example | Exact score |
|---|---|
| BOOMERANGS extending RANG at F1–I1 | 31 × (6 + 0) = **186** |
| ROOMMATE at B1; pillars B2/B6; spans B3/B4/B5 | 21 × (4 + 3) = **147** |
| BOOMERANG across row 5, plus vertical secondary BOOMERANG | 29 × (5 + 2) + 29 × 2 = **261** |
| SOS, plus ordinary secondary BOOMS and RANGS | 5 × (2 + 0) + 17 + 15 = **42** |
| ANOPIAS using an old P and six new tiles | 17 × (3 + 0) + 120 = **171** |

ANOPIAS makes six secondary bridges: **HAY 18, ING 20, ZOA 24, GIO 16, NAP 24, ASH 18**. Their total is 120. Each secondary's bridge status is independent of the principal's.

## Other actions and finishing

**NO WORDS** skips only the current turn, scores zero and permits later turns. It is available only if at least one consonant was actually drawn this turn and the opponent has not permanently passed. Otherwise, place a word or PASS.

**PASS** permanently forfeits the current turn and all future turns. It scores zero, receives the completed turn's final 30-second increment once, and then freezes that player's clock and score. They receive no further draws or turns and may leave without a disconnection loss. The opponent takes consecutive normal turns, choosing words or PASS; NO WORDS is unavailable. Both passing ends the game by score. Emptying the bag alone does not end a game.

## Clocks, connection loss and service recovery

Only the active player's clock runs. Placing a valid word, NO WORDS and PASS each complete a turn and add 30 seconds. Invalid attempts do not. A clock reaching zero loses regardless of score. The server must accept a move before the deadline; equality belongs to the deadline.

After the server detects a player disconnection, the player has 25 seconds to return. Their active clock continues during this grace period. A still-connected game tab prevents disconnection. Permanent PASS players are exempt. If clock and disconnection losses compete, the earliest deadline decides. Exactly simultaneous eligible losses by different players close without a winner.

Confirmed service interruptions/deployments pause affected clocks and reconnect allowances, preserving acknowledged actions. Once service recovers, remaining non-PASS players have up to 120 seconds to reconnect. Play resumes after a short countdown. If a required player remains absent, the game closes without a winner.

## Spectators and replay

Anyone can watch or replay without an account. Public information includes the board, moves, scores, both visible clocks, both rack sizes, exact remaining counts of each vowel, and the total consonants in the bag. Opponent rack letters, per-consonant bag counts, private draw order and drafts remain hidden. History opens finished games and their replay.

An account may advertise one open seek and actively play one game at a time; a permanently passed game no longer occupies that playing slot. Usernames contain 3–15 ASCII letters/digits and are case-insensitively unique. Passwords contain 12–128 characters. There is no email-based recovery in this version.

## Complete letter reference

Count is the original quantity in the bag. Value is the fixed scoring value. Values and counts below are generated directly from the production engine.

| Letter | Type | Value | Count |
|---|---|---:|---:|
{{LETTER_TABLE}}

**Total: 267 tiles. Vowels: 90. Consonants: 177.**
