# Privacy and governance (Stage 7)

This document maps each privacy feature of AI Memory Organizer to India's **Digital Personal Data Protection Act,
2023** (DPDP Act, Act No. 22 of 2023) and to the EU **General Data Protection Regulation** (GDPR, Regulation (EU)
2016/679). It is an engineering mapping written for a student project. **It is not legal advice.**

> **Status of this document.** Written by Claude (an AI model) from its own knowledge, without access to the legal
> texts during writing. Every section number below must be checked against the official text by a person before it
> is quoted in a report or viva. Items marked **`TODO: verify`** are the ones I am least sure of. Sources to check
> against: the DPDP Act as published in the Gazette of India (MeitY website), the DPDP Rules, 2025, and the GDPR on
> EUR-Lex. The ROADMAP asks for "someone (your guide or a classmate)" to do this check.

## 1. What personal data the app holds

| Collection | Personal data | Why it exists |
|---|---|---|
| `users` | name, email, occupation, password hash | Account and login |
| `conversations`, `messages` | everything the user typed, and assistant replies | The chat history the memories are extracted from |
| `memories` | short facts about the user, every version, with an embedding vector | The memory store (Stages 2 to 4) |
| `auditlog` | snapshots of memory versions before and after each change | Accountability, history |
| `suggestions` | facts found in categories set to "ask", waiting for a decision | Stage 7 consent |
| `consents` | the user's choice per category | Stage 7 consent (and proof of it) |
| `jobs` | extraction job results: per candidate fact the category, topic and decision | Stage 3 pipeline |
| `llmcalls` | metadata only (tokens, latency, model); no prompt or answer text | Cost analysis |
| `evalitems` | benchmark questions and answers (LoCoMo) | Stage 6 evaluation, benchmark users only |

Health facts are stored with `sensitivity: "special"` (the Health category defaults to it since Stage 2).

When `LLM_PROVIDER=anthropic`, the new message and a short window of earlier messages are sent to the model
provider for extraction, and the top-k memories are sent when answering `/api/ask`. The provider is then a **data
processor**. Tests and CI never do this (they use the mock).

## 2. Feature map

| # | Feature (where in the code) | DPDP Act 2023 | GDPR | Notes and gaps |
|---|---|---|---|---|
| 1 | **Consent per category**: `store` / `ask` / `never` (`services/consentService.js`, `PUT /api/me/consent/:category`). Enforced in the extractor and in `memoryService` | s.6(1): consent must be free, specific, informed, unconditional and unambiguous, and limited to the data necessary for the purpose. s.4: consent as a ground for processing | Art. 6(1)(a) consent; Art. 7 conditions for consent; Art. 9(2)(a) **explicit** consent for special categories | Gap: the default with no choice made is `store`, including Health. Under GDPR Art. 9 that is not explicit consent; a production setting should default special categories to `ask` or `never`. No notice is shown (DPDP s.5, GDPR Art. 13) |
| 2 | **"ask" mode**: facts wait as suggestions until the user accepts (`services/suggestionService.js`) | s.6(1) "clear affirmative action" | Art. 4(11) consent is "a clear affirmative act"; Art. 9(2)(a) | Accepting is an affirmative act per fact. The suggestion itself is still stored before the decision (it is personal data too) and is erased with its source message |
| 3 | **Withdrawal of consent erases the category** (`setConsent` with `mode: "never"`, unless `eraseExisting: false`) | s.6(4) right to withdraw, as easily as consent was given; s.6(6) stop processing within a reasonable time after withdrawal; s.8(7)(a) erase on withdrawal. `TODO: verify` subsection numbers | Art. 7(3) withdraw at any time, as easy as giving it; Art. 17(1)(b) erasure when consent is withdrawn and there is no other legal ground | Withdrawal is one request. `eraseExisting: false` keeps old facts, which is only lawful if another ground applies; the app does not check that |
| 4 | **Lineage-based erasure**: deleting a message or a conversation erases every memory version derived only from it, with its embedding, suggestions and jobs, in one transaction (`services/erasureService.js`) | s.12(1) and s.12(3) right to erasure of data processed on consent; s.8(7) erase when the purpose is no longer served. `TODO: verify` subsection numbers | Art. 17(1) right to erasure ("right to be forgotten") | This is the feature the thesis is about: provenance (`sourceMessageIds`) makes erasure **exact** instead of "search for similar text". A version with other surviving sources is kept and flagged for review, not re-derived |
| 5 | **Audit log tombstones**: entries about erased versions keep action, time and actor, but no content; an `erase` entry is added (`AuditLog.tombstone`) | s.8(1) the Data Fiduciary is responsible for compliance (needs a record) | Art. 5(2) accountability; Art. 17 erasure | Keeps the *fact* that an erasure happened (accountability) without keeping *what* was erased. The log is append-only except for these erasure updates |
| 6 | **Erasure verification**: `npm run erasure:verify`, `GET /api/me/erasure-check` (`services/erasureVerifier.js`) | s.8(1) responsibility for compliance; s.8(7) | Art. 5(2) and Art. 24 (be able to *demonstrate* compliance) | Checks the database only. It cannot see backups, the replica-set oplog or the model provider (see section 4) |
| 7 | **Account deletion** (`DELETE /api/users/me`): every collection, one transaction | s.12(3) erasure; s.8(7) | Art. 17(1) | Stage 1 feature, extended in Stage 7 to consents and suggestions |
| 8 | **Export** (`GET /api/me/export`): every row about the user from every collection, as JSON | s.11 right to obtain a **summary** of the personal data processed and the processing activities. DPDP has no data-portability right like GDPR Art. 20. `TODO: verify` | Art. 15(3) copy of the data; Art. 20 portability: "structured, commonly used and machine-readable format" | JSON satisfies "machine-readable". DPDP s.11 also asks for the identities of other fiduciaries/processors the data was shared with; the export does not list the LLM provider. Embedding vectors are included only with `?embeddings=true` |
| 9 | **Retention of special data** (`npm run retention`, `RETENTION_SPECIAL_DAYS`, `services/retentionService.js`) | s.8(7)-(8) erase once the purpose is no longer served; the DPDP Rules, 2025 set erasure periods for some classes of large platforms (3 years of inactivity, with 48 hours' notice). `TODO: verify` the Rules' numbers and whether they apply to this kind of service | Art. 5(1)(e) storage limitation | A scheduled job, not a TTL index, so expiry repairs version chains and tombstones the log like any other erasure. The period is one global number; it is off unless configured. Benchmark/synthetic rows are exempt (not real people) |
| 10 | **Sensitivity labels** (`normal`, `personal`, `special`; Health is `special` by default) | DPDP 2023 has **no separate category** of sensitive personal data: all personal data is treated alike (children's data has extra rules, s.9). The older SPDI Rules, 2011 under s.43A of the IT Act did list medical records; DPDP s.44 amends the IT Act and omits s.43A. `TODO: verify` | Art. 9(1) special categories include "data concerning health" (defined in Art. 4(15)) | The label drives retention (feature 9). It is set by category or by the extractor's guess, which can be wrong |
| 11 | **Rectification**: `PUT /api/memories/:id` with `"correction": true` creates a corrected version (Stage 2) | s.12(2) correction, completion and updating. `TODO: verify` | Art. 16 rectification | The wrong version is retracted but kept in the history (transaction time). If the user wants the wrong value gone too, that is an erasure request (features 4, 7) |
| 12 | **Data minimisation in logs**: `llmcalls` stores no prompt or answer text; the extractor receives only the new message and a short window | s.6(1) "limited to such personal data as is necessary" | Art. 5(1)(c) data minimisation; Art. 25 data protection by design and by default | |
| 13 | **Security**: every query is scoped to the authenticated user; passwords are bcrypt hashes; ids are validated | s.8(5) reasonable security safeguards to prevent a personal data breach | Art. 32 security of processing | No encryption at rest, rate limiting or breach detection (see section 4) |
| 14 | **The LLM provider as processor** (`services/llm/`) | s.8(2) a Data Fiduciary may use a Data Processor only under a valid contract; s.8(7)(b) cause the processor to erase too; s.16 cross-border transfer (allowed unless the destination is restricted by notification). `TODO: verify` | Art. 28 processor contract; Art. 17(2) and Art. 19 tell recipients about erasure; Chapter V (Art. 44-49) international transfers | Not implemented: erasure in this database does not reach the provider. Check the provider's data retention and training terms before using real users' data. `TODO: verify` the provider's current terms |

## 3. How erasure works (for the viva)

1. **Lineage lookup.** `Memory.find({ userId, sourceMessageIds: { $in: erasedMessageIds } })` on the multikey index
   `{ userId, sourceMessageIds }`.
2. **Split.** A version whose sources are *all* erased is deleted. A version with another surviving source is kept,
   the erased ids are `$pull`ed from it, and it gets `erasureReview` (listed by `GET /api/memories?needsReview=true`).
3. **Repair the version chain** (`planChain`). Survivors are relinked to each other. If the erased version was the
   current one, the version it closed becomes current again: the database returns to what it would hold had the
   message never been sent. A version the user had retracted is not brought back.
4. **Audit log.** Entries about erased versions are tombstoned (content blanked, `tombstonedAt` set), erased ids are
   removed from surviving snapshots, and one `erase` entry per erased version is appended.
5. **Other derived data.** Suggestions and extraction jobs of the messages are deleted; benchmark labels drop them
   from `evidenceMessageIds`.
6. **One transaction** (MongoDB replica set): all of it commits, or none of it (tested by failing the audit write).
7. **Verification** with anti-joins (`$lookup` that finds no match): no reference from any collection points at a
   missing message or version, and optionally the erased ids or a phrase appear nowhere.

## 4. Known gaps (honest list)

- **Backups and the oplog.** A hard delete removes the document from the collection, but MongoDB's replica-set
  oplog keeps the insert until the oplog rolls over, and any backup keeps it until the backup expires. A production
  system documents a backup retention period and states it in the erasure response. Not done here.
- **The model provider.** Text sent to the LLM for extraction or answering is outside this database. Erasure does
  not reach it (DPDP s.8(7)(b), GDPR Art. 17(2)/19). `TODO: verify` the provider's retention terms.
- **Default consent is "store".** Fine for a demo, not explicit consent for health data under GDPR Art. 9(2)(a).
- **No notice or consent record history.** DPDP s.5 and GDPR Art. 13 require a notice before collection. Only the
  latest choice per category is stored (with `updatedAt`); proving past consent (DPDP s.6(10), GDPR Art. 7(1))
  would need an append-only consent log. `TODO: verify` s.6(10).
- **Flag, not re-derive.** A memory with several sources keeps its text when one source is erased. The text may
  still contain something learned from the erased message; the user has to review it.
- **Hand-made memories have no lineage.** A memory created through the API without `sourceMessageIds` is not
  erased with a conversation (it is only unlinked). It can be erased with the account or by consent withdrawal.
- **Race with a running extraction job.** If a message is erased while its job is already running, the job's write
  is refused because the source message no longer exists (the memory service checks it), but that check happens
  just before the job's own transaction, so a very narrow window remains.
- **Not implemented:** breach notification (DPDP s.8(6), GDPR Art. 33-34), grievance officer / DPO contact
  (DPDP s.8(10) and s.13, GDPR Art. 37-39), children's data and verifiable parental consent (DPDP s.9, GDPR Art. 8),
  consent managers (DPDP s.6(7)-(9)), restriction of processing (GDPR Art. 18), a data protection impact assessment
  (GDPR Art. 35; likely required for large-scale processing of health data). `TODO: verify` the subsection numbers.
- **Research use.** The benchmark data (LoCoMo) is stored with `dataset: "benchmark"`. DPDP s.17 has an exemption for
  research and statistical purposes when the data is not used to take decisions about a particular person.
  `TODO: verify` s.17(2)(b). docs/DATASETS.md records that the LoCoMo paper describes its dialogues as
  machine-generated (so not real people's chats) and that its licence is CC BY-NC 4.0 (non-commercial).

## 5. Checklist for the person verifying this document

- [ ] DPDP Act 2023: s.4, s.5, s.6(1), s.6(4), s.6(6), s.6(7)-(10), s.8(1), s.8(2), s.8(5)-(8), s.8(10), s.9,
      s.11, s.12(1)-(3), s.13, s.16, s.17(2)(b), s.44 (omission of IT Act s.43A).
- [ ] DPDP Rules, 2025: commencement dates, erasure periods for large platforms, notice before erasure.
- [ ] GDPR: Art. 4(11), 4(15), 5(1)(c), 5(1)(e), 5(2), 6(1)(a), 7(1), 7(3), 9(1), 9(2)(a), 13, 15(3), 16, 17(1)(b),
      17(2), 19, 20, 24, 25, 28, 32, 33-34, 35, 44-49.
- [ ] The LLM provider's data retention and training terms.
