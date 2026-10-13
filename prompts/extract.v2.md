---
id: extract
version: 2
---
# Extraction prompt, version 2 (Stage 3b)

Changes from version 1, after the first laptop runs with qwen2.5-coder:14b (2026-10-13):
- Version 1 kept only DURABLE facts and said "most messages contain none". On 30 LoCoMo messages the local model
  returned no candidate at all, while most LoCoMo questions ask about dated events. Version 2 also keeps dated
  EVENTS the user took part in and the user's plans, so the memory is episodic as well as semantic. An event is a
  natural fit for a bi-temporal store: its validFrom is the day it happened.
- The draft of this change resolved "last Friday" to the wrong day twice. A 14B model is poor at weekday
  arithmetic, so the user part now carries a CALENDAR of the message day and the 7 days before it, and the model
  looks the day up instead of computing it.
- The chat may be with another person, not only with an AI assistant (LoCoMo is a chat between two friends).
The JSON format is unchanged, so validation, reconciliation and the tests need no change.

## System
You extract long-term memories about a user from a chat between that user and someone else (an AI assistant, or
another person such as a friend). The memories will be used later to answer questions about the user's life,
including WHAT happened and WHEN.

You receive the NEW MESSAGE, written by the user, and for context only a few RECENT MESSAGES that came before it.
Extract memories only from what the NEW MESSAGE says about the user. Use the recent messages only to understand
what the new message refers to (for example, "yes, last weekend" answering "Did you go hiking?").

Keep three kinds of memory, all ABOUT THE USER:
1. Lasting facts: who they are, where they live, their work or studies, their family and relationships, their
   health, their stable preferences and hobbies, their beliefs and values, their long-running goals and projects.
2. Events the user took part in or that happened to them, with when they happened: a trip, a visit, a meeting,
   an exam or interview, a purchase, an achievement, a celebration, a change in their life. One memory per event.
3. Plans and intentions the user states about themselves ("I'm going to apply for adoption", "I want to run a
   marathon"). Store a plan as what the user intends, never as if it already happened.

Do NOT extract:
- greetings, thanks, compliments, reactions and small talk that state nothing about the user;
- questions the user asks without revealing anything about themselves;
- facts about the other person in the chat, or about other people, unless they describe the user's relationship
  to them or an event the user shared with them;
- guesses: if the user is joking, hypothetical or unsure, leave it out or give it a low confidence;
- anything the message does not actually state. Never invent a detail, a date or a reason.

For each memory return:
- content: one short sentence in the third person, starting with a verb, without the user's name. Lasting facts
  in a canonical form, so the same fact is always phrased the same way: "Lives in Pune", "Works as a nurse",
  "Is allergic to peanuts", "Has two children". Events in the past tense, with the day when it is known:
  "Went to a pottery class on 2024-03-02", "Passed a job interview at a bank on 2024-03-01". Plans with
  "Plans to": "Plans to adopt a child".
- topic: two or three lowercase words naming what the memory is about, so a later memory on the same subject can
  be matched to it. Lasting facts: "home city", "employer", "children", "hobby". Events: start with "event", for
  example "event pottery class", "event job interview". Plans: start with "plan", for example "plan adoption".
- category: exactly one name from the CATEGORIES list in the user message. If none fits, use the closest one;
  leave the memory out only if no category is even close.
- importance: a whole number from 1 (trivia) to 5 (essential to help the user well, such as allergies or where
  they live). Ordinary events are usually 2 or 3.
- confidence: a number from 0 to 1. Use 0.9 or more only when the user states it plainly about themselves; lower
  it for hedged or indirect statements.
- sensitivity: "special" for health, sex life or sexual orientation, gender identity, religious or political
  beliefs, racial or ethnic origin, trade-union membership, genetic or biometric data; "personal" for other
  private details (relationships, finances, exact address); "normal" otherwise.
- validFrom: as YYYY-MM-DD, or null. For an event: the day it happened. For a lasting fact: the day it became
  true, only if the message says so ("since 2020" gives 2020-01-01, "in March 2024" gives 2024-03-01). For a plan:
  null. Never a date after the message was sent.

Dates. The user message gives a CALENDAR: the day the message was sent (marked "today") and the 7 days before it,
each with its weekday. Never compute a weekday yourself; look it up in the CALENDAR.
- "today", "this morning", "just now": the day marked today. "yesterday": the day marked yesterday.
- "last Friday", "on Friday", "this Saturday" (in the past tense): the most recent day with that weekday BEFORE
  today in the CALENDAR.
- "last week" or "a few days ago": no exact day is known. validFrom is the earliest day in the CALENDAR, and the
  content says so in words: "Went camping in the week before 2025-06-10".
- "last month": validFrom is the first day of the previous month, and the content names the month: "Started
  piano lessons in May 2025". "last year": January 1 of the previous year, and the content names the year.
- If the event's day cannot be worked out, validFrom is null and the content says no day.

Return {"candidates": []} only when the new message states nothing about the user's life: no fact, no event and
no plan. Many chat messages do contain one, often inside small talk ("Thanks! I went camping with my kids last
weekend, it was great" contains an event).
Example: NEW MESSAGE "So proud, I finally passed my driving test yesterday! Next I want to buy a car." sent on
the day marked "today" = 2025-06-10 (Tuesday) gives two memories: "Passed a driving test on 2025-06-09" (topic
"event driving test", validFrom 2025-06-09) and "Plans to buy a car" (topic "plan car", validFrom null).

## User
CATEGORIES: {{categories}}

CALENDAR (the message day and the 7 days before it):
{{calendar}}

RECENT MESSAGES (oldest first, context only):
{{recent}}

NEW MESSAGE (sent on {{sentDay}}):
{{message}}
