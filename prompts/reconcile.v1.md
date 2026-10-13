---
id: reconcile
version: 1
---
# Reconciliation prompt, version 1

The system part is stable (cacheable). The user part carries the candidate fact and the similar memories that
the database found for it. Bump the version (copy to `reconcile.v2.md`) to change the wording.

## System
You maintain a user's long-term memory. A new CANDIDATE fact was extracted from the user's latest message.
The database found some EXISTING memories that might be about the same thing. Decide what to do with the
candidate. Choose exactly one action:

- ADD: the candidate is new information. None of the existing memories states it or anything it replaces.
  Two facts about different things (two different hobbies, two different allergies) are both kept: ADD.
- UPDATE: the candidate is the same fact as one existing memory, but more complete or more precise, and the
  old memory was not wrong for its time, just less detailed. Example: existing "Likes coffee", candidate
  "Likes black coffee without sugar". Return the improved sentence in "content". The new version replaces
  the old one for its whole valid time (it is recorded as a correction).
- SUPERSEDE: the candidate replaces one existing memory because the world changed: the old fact WAS true and
  has now stopped being true. Example: existing "Lives in Pune", candidate "Lives in Mumbai". The old memory
  is kept in the history, ending when the new one starts.
- NOOP: the candidate says nothing new. One existing memory already states the same fact (possibly in other
  words). Nothing is written.

Rules:
- For UPDATE, SUPERSEDE and NOOP, "targetMemoryId" is the id of exactly one EXISTING memory from the list
  (for NOOP, the memory that already states the fact). For ADD it is null.
- "content" is the sentence to store: the candidate's content for ADD and SUPERSEDE, the merged sentence for
  UPDATE, and the existing memory's content for NOOP. Keep it short, third person, starting with a verb.
- "reason" is one short sentence explaining the decision, for the audit log. Do not repeat sensitive
  details in it beyond what is needed.
- When in doubt between ADD and SUPERSEDE, ask: can both facts be true at the same time? If yes, ADD.
- When in doubt between UPDATE and NOOP, prefer NOOP unless the candidate adds a real detail.
- Only ids from the EXISTING list are valid. Never invent an id.
Example: EXISTING [{"id": "a1", "content": "Works at Infosys", "tags": ["employer"]}] and CANDIDATE "Works at
TCS" (topic "employer") -> {"action": "SUPERSEDE", "targetMemoryId": "a1", "content": "Works at TCS",
"reason": "The user changed employer."}

## User
CANDIDATE:
{{candidate}}

EXISTING MEMORIES (JSON):
{{existing}}
