# Executive Brief — Event Sourcing

**Audience:** CPO, CFO, VP Engineering
**Reading time:** 5 minutes
**Status:** Account Domain — Implementation Approved

---

## The Problem We Cannot Ignore

We cannot reliably answer "what happened and why?" for our financial transactions and customer account actions.

When regulators asked for a 7-year audit history last quarter, we reconstructed it manually from application logs — a process that took three days, could not be proven complete, and identified gaps that our auditors flagged. When a bug caused incorrect account balances in March, determining which transaction caused it required a 3-day investigation across three engineering teams, two database environments, and application logs that we were not certain were complete.

This is not a tooling problem or a logging problem. It is an architectural problem: our system was designed to record only current state, not the history of how we arrived there. Every time we update an account balance, we overwrite the previous value. The history is gone.

As we add more financial products and take on more regulated workloads, the cost of this architectural gap compounds.

---

## What We Are Doing

We are changing how we store the Account domain's state — from "overwrite current state" to "append a record of every fact that occurred."

Think of the difference between a whiteboard and a ledger. A whiteboard shows the current number. A ledger shows every transaction that produced it, with timestamps and context. We currently run a whiteboard. We are switching to a ledger.

This is called **Event Sourcing**: every business fact (an account was opened, money was deposited, a limit was changed) is stored as an immutable, timestamped record — an event. Current state is computed by reading the history of events. Nothing is ever overwritten or deleted.

**What this produces:**
- A complete, provable audit trail from the moment the Account domain goes live
- The ability to answer "what was this account's state on March 15 at 2:43 PM?" instantly
- The ability to replay the full history to find the exact event that caused a balance discrepancy
- Automatic evidence generation for SOC 2 Type II audit requirements
- A foundation for regulatory reporting that takes minutes to generate, not days

---

## Investment Required

| Item | Estimate |
|---|---|
| Engineering time | 2 senior engineers × 4 weeks = 8 engineer-weeks |
| Infrastructure | $200–800/month (event store + read model databases) |
| Schema tooling | $50–200/month (schema registry for event validation) |
| One-time setup | Data migration for existing Account records: 1 additional engineer-week |

**Total year-one cost:** Approximately $55,000–65,000 (fully-loaded engineering + infrastructure).

**Infrastructure cost context:** The ongoing infrastructure cost ($200–800/month) is lower than the cost of a single engineer-day spent investigating a balance discrepancy that this system would have resolved in minutes.

---

## What We Gain

**Regulatory compliance:**
Audit requests that currently take 3 days and produce incomplete results will be answered in under 10 minutes with a complete, provable trail. The event log is the audit evidence — it does not need to be reconstructed.

**SOC 2 Type II:**
The immutable event log directly satisfies the CC6.1 control requirement for logical access audit records. Our next SOC 2 audit will have machine-generated evidence rather than manually compiled log exports.

**Bug investigation speed:**
The March balance discrepancy investigation took 3 days. With Event Sourcing, the investigation is: find the account ID, load its event history, identify the event that caused the divergence. Target: under 2 hours for any balance discrepancy investigation.

**New reporting without new migrations:**
Every new reporting requirement on the Account domain becomes a new query against the event history — not a new database schema migration. Adding a report on "accounts that had more than 3 failed transactions in 30 days" requires a new projection, not a schema change to the accounts table.

**Foundation for new products:**
Every new financial product we add to the Account domain inherits the complete event history automatically. Credit products, savings products, and investment accounts can all be expressed as events on the same aggregate — no new audit infrastructure required per product.

---

## Risk of Inaction

**Regulatory risk:** Our last audit found gaps in our audit trail. The next audit will find the same gaps unless the underlying architecture changes. If our regulatory exposure increases (new products, new jurisdictions, new compliance requirements), the cost of reconstructing incomplete audit trails grows proportionally.

**Operational risk:** As transaction volume grows, the cost and time required to investigate balance discrepancies grows with it. The March incident cost approximately 3 engineer-days across 3 teams. At 5× current volume, the same type of incident would be proportionally more expensive to investigate.

**Opportunity cost:** Every new financial product we launch without this infrastructure starts with zero audit history. The longer we wait, the more historical data we do not have when we eventually adopt Event Sourcing.

---

## What We Are Not Doing

- **Not changing any customer-facing APIs or behavior.** The Account API continues to accept the same requests and return the same responses. The change is internal to how state is persisted.
- **Not replacing the existing database.** The read-optimized query database remains. Event Sourcing adds the event log alongside it — the read model database continues to serve queries.
- **Not a big-bang migration.** We are starting with the Account domain only. This is a proof of pattern, not an organization-wide replatforming.
- **Not increasing system complexity for existing teams.** The command API and query API interfaces are unchanged. Only the persistence implementation changes.

---

## Decision Request

Approval to proceed with the Account domain Event Sourcing implementation as scoped:
- 2 engineers × 4 weeks
- Infrastructure budget: $1,000/month ongoing (covers event store, read model database, schema registry)
- Target completion: 8 weeks from kickoff (4 weeks implementation + 2 weeks testing + 2 weeks staged rollout)

The first regulatory audit request that is answered in 10 minutes rather than 3 days is the return on this investment.
