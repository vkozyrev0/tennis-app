# Leftover-email LLM prompt (final)

One **shared** leftover prompt classifies every inbox email the keyword
rules left as `other`. There is no per-message template. Source of truth:
`backend/app/email_llm.py` (`_SYSTEM`, `_SHOTS`, `leftover_prompt`,
`leftover_model_intent` / `extract_email`). Tests fail if this file drifts
from those strings.

Model: local llama.cpp sidecar, **Qwen2.5-1.5B-Instruct Q4_K_M**. Heuristic
`triage.classify()` still runs first; this prompt is used only when that
result is `other` and `EMAIL_LLM=1`. Junior PII stays on-box (D5) — no
cloud LLM.

Do **not** paste tournament-corpus subjects into the few-shots. Examples
use invented names (Jane Roe / Alex Kim / Sam Lee / Jordan Blake / Casey Ng)
so the model learns the rule. Tests fail if a gold PDF subject appears as a
`Subject:` line in the template.

## Intents this prompt covers

| Intent | What it is |
|---|---|
| `withdrawal` | Cancel / withdraw from **singles**, **doubles**, or both (USTA WITHDRAWAL REQUEST, “please cancel”, “I need to withdraw”). |
| `late_entry` | Request to still **enter or add a player in singles** after the deadline. |
| `doubles` | Name a doubles partner, doubles confirmation with a real confirm body, or add someone for doubles / find a partner. |
| `other` | Latest line is only an ack (Thanks / Will do / We will pair them), a CC-only `C:` line, or “please ask them to email”. |
| `pairing_avoidance` / `scheduling_avoidance` / `division_flex` / `hotel` | Only when the latest body clearly asks for that. |

This PDF corpus has **singles and doubles cancellations** (gold =
`withdrawal`) and **no standalone singles-entry / late_entry row**.
`late_entry` is still in the prompt so a future “can we still enter
singles?” email classifies without a new template.

`extract_email` returns the model’s parsed JSON **unguarded** (no
post-rewrite of `intent`).

## Call shape

`leftover_model_intent(subject, body)` (also `extract_email`):

1. `clip_email_text` — drop quoted threads, signatures, PDF `[Date]` /
   `[To]` wrappers; cap body length (1200 chars).
2. `leftover_prompt(clipped_subject, clipped_body)` — same `_SHOTS` for
   every email; only `{subject}` / `{body}` change (via `str.replace`, not
   `.format`, so JSON braces in the few-shots survive).
3. Chat completion: system = `_SYSTEM`, user = that few-shot string,
   `temperature=0`, `max_tokens` default 192.
4. `parse_llm_json` — `intent` is whatever the model returned (unknown
   intents coerce to `other`; that is schema cleanup, not a rule rewrite).

Inbox hybrid (`maybe_intent`): keep a non-`other` heuristic; call this
path only for leftover `other`. If the model is off, times out, returns
`other`, or `confidence < 0.6`, the heuristic stands.

### Clip (what the model actually sees)

`clip_email_text` keeps the **latest body** only:

- Cut at the first of: `-----Original Message-----`, `________________________________`,
  `\nFrom:`, spam-scan footer, USTA “registered tennis player” footer,
  `\nGet Outlook for iOS`, `\nSent from my iPhone`.
- Cut at `\nOn … wrote:` (short single-line match, then a longer
  multiline match) so quoted threads drop without eating a short
  `On Mon, Jane wrote:` unit-test body.
- Strip a leading PDF `[Date:…]` then `[To:…]` wrapper (inbox PDF import).
- Cap at 1200 characters on a word boundary. Subject is capped at 200.

The query slot is **body-first**: `Body:` then `Subject:`, so a short ack
is read before a doubles/withdraw subject.

## Expected JSON

```json
{
  "intent": "withdrawal | doubles | late_entry | pairing_avoidance | scheduling_avoidance | division_flex | hotel | other",
  "reason": "short phrase",
  "players": [{"name": "…", "usta": null}],
  "confidence": 0.9
}
```

`players[].usta` is optional. Markdown fences around the JSON are stripped.

## System message (`_SYSTEM`)

```
You classify leftover USTA junior/adult tournament emails. Reply with JSON only, no markdown. intent must be one of: withdrawal, doubles, late_entry, pairing_avoidance, scheduling_avoidance, division_flex, hotel, other. players is a list of {name, usta}. confidence is 0..1. Classify the LATEST body only (ignore Re:/FW:/**EXTERNAL** and quotes). Cancel / cancellation of singles or doubles is withdrawal (same as withdraw / WITHDRAWAL REQUEST). A request to still enter or add a player in singles is late_entry. A request to add/enter doubles or name a doubles partner is doubles. pairing_avoidance only if they ask two players not to play each other. Rules, in order: (1) Latest body is a short ack (Thanks / Thank you / Thank you for confirming / Will do / Sure / Yes I did / We will pair them / No worries) OR asks someone to email / confirm they are good → other, even if the subject says withdraw, cancel, doubles, singles, confirmation, or pairing. (2) Else two people named as partners / would like to be partners / will partner → doubles (a trailing Thank you does not cancel that). (3) Else withdraw / cancel / WITHDRAWAL REQUEST / requested to be withdrawn from singles and/or doubles → withdrawal. (4) Else missed the deadline / still enter / add NAME in singles → late_entry. (5) Else subject contains Doubles Confirmation and the latest body confirms a pair (not only a C: address or Thank you) → doubles. (6) Else add NAME for doubles / find a partner → doubles. (7) Else other. Set intent to match the rule. Do not set intent from the subject alone when the body is an ack. If reason is acknowledgement or waiting on email, intent is other unless the body lists two people as doubles partners.
```

## User few-shots (`_SHOTS`)

`{subject}` and `{body}` are filled after clip. The examples are fixed
and generic.

```
Example 1
Subject: WITHDRAWAL REQUEST: Jane Roe, Girls' 16 & under singles
Body: Jane Roe has requested to be withdrawn from singles.
{"intent":"withdrawal","reason":"cancel/withdraw singles","players":[{"name":"Jane Roe","usta":null}],"confidence":0.9}

Example 2
Subject: Please cancel doubles
Body: Please cancel Jane Roe from doubles.
{"intent":"withdrawal","reason":"cancel/withdraw doubles","players":[{"name":"Jane Roe","usta":null}],"confidence":0.9}

Example 3
Subject: Doubles partners
Body: Alex Kim and Sam Lee Doubles partners Thank you
{"intent":"doubles","reason":"named pairing","players":[{"name":"Alex Kim","usta":null},{"name":"Sam Lee","usta":null}],"confidence":0.9}

Example 3b
Subject: Partner request
Body: Alex Kim and Sam Lee would like to be doubles partners. Please put them together.
{"intent":"doubles","reason":"named pairing","players":[{"name":"Alex Kim","usta":null},{"name":"Sam Lee","usta":null}],"confidence":0.9}

Example 3c
Subject: Re: Event Doubles
Body: Good morning,
Alex Kim and Sam Lee
Doubles partners
Thank you
Pat
{"intent":"doubles","reason":"named pairing","players":[{"name":"Alex Kim","usta":null},{"name":"Sam Lee","usta":null}],"confidence":0.9}

Example 4
Subject: Re: Boys 16s Doubles Confirmation-Level 4 Open
Body: Please confirm Alex Kim for doubles.
{"intent":"doubles","reason":"doubles confirmation","players":[{"name":"Alex Kim","usta":null}],"confidence":0.8}

Example 5
Subject: Missed deadline
Body: Can we still enter Jordan Blake in singles?
{"intent":"late_entry","reason":"singles entry request","players":[{"name":"Jordan Blake","usta":null}],"confidence":0.8}

Example 6
Subject: Jordan Blake
Body: Can you add Jordan for doubles if it is not too late. We will try to find a partner.
{"intent":"doubles","reason":"add for doubles","players":[{"name":"Jordan Blake","usta":null}],"confidence":0.8}

Example 7
Subject: Re: Withdrawal Request
Body: Thank you
{"intent":"other","reason":"acknowledgement","players":[],"confidence":0.9}

Example 8
Subject: Re: Jordan Blake doubles pairing change
Body: Will do
{"intent":"other","reason":"acknowledgement","players":[],"confidence":0.9}

Example 9
Subject: Re: Casey Ng - Doubles partner
Body: We will pair them.
{"intent":"other","reason":"acknowledgement","players":[],"confidence":0.9}

Example 10
Subject: Re: Pairing
Body: Please ask the partner to email to confirm.
{"intent":"other","reason":"waiting on partner email","players":[],"confidence":0.85}

Example 10b
Subject: Re: Question
Body: Please ask his parent to email me. Thanks!!
{"intent":"other","reason":"waiting on parent email","players":[],"confidence":0.85}

Example 10c
Subject: Re: Event pairing
Body: Please ask her partner to email also to confirm, if not sent already.
{"intent":"other","reason":"waiting on partner email","players":[],"confidence":0.85}

Example 10d
Subject: Re: Doubles pairing request
Body: Please ask the partner to also email if they have not already.
{"intent":"other","reason":"waiting on partner email","players":[],"confidence":0.85}

Example 11
Subject: Re: Withdrawal
Body: Thanks.
{"intent":"other","reason":"acknowledgement","players":[],"confidence":0.9}

Example 12
Subject: Re: Event
Body: Yes, I did.
{"intent":"other","reason":"acknowledgement","players":[],"confidence":0.9}

Example 13
Subject: Re: Partnership
Body: Sure.
{"intent":"other","reason":"acknowledgement","players":[],"confidence":0.9}

Example 14
Subject: Re: Partners
Body: please confirm they are good to go. Thanks!
{"intent":"other","reason":"waiting on confirm","players":[],"confidence":0.85}

Example 15
Subject: Re: Boys doubles - Roe / Kim
Body: C: Jane Roe
Thank you!
{"intent":"other","reason":"acknowledgement","players":[],"confidence":0.9}

Example 16
Subject: Re: Doubles Confirmation thread
Body: C: dad@gmail.com
{"intent":"other","reason":"cc only","players":[],"confidence":0.9}

Example 17
Subject: Re: girls doubles partner
Body: Please ask Alex to email us to verify.
{"intent":"other","reason":"waiting on partner email","players":[],"confidence":0.85}

If the body is only an ack or asking someone to email, intent is other.
The body "We will pair them." is other (it is an ack, not a new pairing).
A body that is only a C: address is other.
Will do as the whole Body is other, not named pairing, even when Subject says doubles pairing change.
will partner with two named players is doubles, not an ack.
Now extract. Read Body first; if it is an ack, intent is other even when Subject says withdraw or doubles.
Body: {body}
Subject: {subject}
```

## Rule order (same as `_SYSTEM`)

1. Short ack or “ask them to email” → `other` (subject is ignored).
2. Two people named as partners (trailing Thank you does not cancel) → `doubles`.
3. Withdraw / cancel singles and/or doubles → `withdrawal`.
4. Still enter / add NAME in singles → `late_entry`.
5. Subject contains Doubles Confirmation **and** the latest body confirms a
   pair (not only `C:` or Thank you) → `doubles`.
6. Add NAME for doubles / find a partner → `doubles`.
7. Else `other`.

## Gold PDF (`tournament_emails.pdf`)

30 parsed rows in `backend/tests/fixtures/tournament_emails_gold.json`.
Labels are this prompt’s intents, not heuristic `classify()`.

| Gold intent | Count | What those rows are |
|---|---|---|
| `other` | 19 | Latest-line acks, wait-on-email, CC-only `C:` |
| `withdrawal` | 6 | USTA WITHDRAWAL REQUEST (singles and doubles) and parent cancel |
| `doubles` | 5 | Named partners / add-for-doubles / real confirmation body |
| `late_entry` | 0 | Taught by Example 5; none in this PDF |

Qwen2.5-1.5B-Instruct Q4_K_M matches **30/30** unguarded on this PDF when the
footer contrast is present: whole-body `Will do` is `other` (not named
pairing from the Subject); `will partner` with two named players stays
`doubles`. Do not add a post-parse `intent` rewrite.

## Tests

- `test_zz_email_llm.py` — shared template, shots are not corpus subjects,
  docs quote `_SYSTEM`/`_SHOTS`.
- `test_zz_pdf_leftover_llm.py` — one `leftover_model_intent` case per
  parsed `tournament_emails.pdf` row (unguarded `parse_llm_json`); gold in
  `backend/tests/fixtures/tournament_emails_gold.json`.
