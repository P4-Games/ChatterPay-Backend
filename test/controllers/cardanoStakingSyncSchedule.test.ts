import { describe, expect, it } from 'vitest';

import { scheduledTimeFrom } from '../../src/controllers/cardanoStakingSyncController';
import { syncRunId } from '../../src/services/cardano/cardanoStakingSyncService';

/**
 * Which tick a delivery belongs to, and what that buys.
 *
 * A scheduled run is identified by its tick, so two deliveries that name the same tick are the same
 * run and the second one does nothing. That is the whole retry story: Cloud Scheduler resends a
 * failed delivery with the same `X-CloudScheduler-ScheduleTime`, and the endpoint recognises it.
 *
 * The case worth protecting is the one that fails silently. A job's body is configured once and
 * sent unchanged forever, so a `scheduledTime` written into it is a fixed date — and if the body
 * won, every tick for the rest of the job's life would share one run id. The first day would run,
 * every following day would be told the run had already completed, each would answer 200, and
 * nothing would look wrong until somebody noticed that nothing had been reconciled in a month.
 */

/** Stands in for the chain the sync runs against. */
const CHAIN_ID = 900_000_000_001;

/** The job name a schedule would use. */
const JOB = 'cardano-staking-sync';

/** A fixed "now", so a test that falls through to it can say so. */
const NOW = new Date('2026-03-01T12:00:00.000Z');

describe('the tick a delivery names', () => {
  it('comes from the header Cloud Scheduler sets', () => {
    const result = scheduledTimeFrom('2026-03-01T03:00:00Z', undefined, NOW);

    expect(result.toISOString()).toBe('2026-03-01T03:00:00.000Z');
  });

  it('prefers the header over the body', () => {
    // The header is generated per delivery. The body is a fixed string somebody typed once.
    const result = scheduledTimeFrom('2026-03-02T03:00:00Z', '2026-01-01T00:00:00Z', NOW);

    expect(result.toISOString()).toBe('2026-03-02T03:00:00.000Z');
  });

  it('falls back to the body when there is no header', () => {
    // A hand-made call naming a tick it wants to resume.
    const result = scheduledTimeFrom(undefined, '2026-02-14T09:30:00Z', NOW);

    expect(result.toISOString()).toBe('2026-02-14T09:30:00.000Z');
  });

  it('falls back to now when neither is present', () => {
    // A manual invocation gets a run of its own rather than colliding with a scheduled one.
    expect(scheduledTimeFrom(undefined, undefined, NOW)).toEqual(NOW);
  });

  it('treats an unparseable header as absent rather than refusing', () => {
    // A delivery should still do the work. Refusing would mean a header format change could stop
    // the schedule dead, and the work is not what the timestamp is for.
    const result = scheduledTimeFrom('not a date', '2026-02-14T09:30:00Z', NOW);

    expect(result.toISOString()).toBe('2026-02-14T09:30:00.000Z');
  });

  it('treats an empty header as absent', () => {
    expect(scheduledTimeFrom('   ', undefined, NOW)).toEqual(NOW);
  });

  it('ignores a header that is not a string', () => {
    // Fastify hands back an array when a header arrives twice.
    expect(scheduledTimeFrom(['2026-03-01T03:00:00Z'], undefined, NOW)).toEqual(NOW);
  });

  it('ignores whitespace around a real value', () => {
    const result = scheduledTimeFrom('  2026-03-01T03:00:00Z  ', undefined, NOW);

    expect(result.toISOString()).toBe('2026-03-01T03:00:00.000Z');
  });
});

describe('what the tick makes idempotent', () => {
  it('gives a retry the same run as the delivery it retries', () => {
    const first = syncRunId(CHAIN_ID, JOB, scheduledTimeFrom('2026-03-01T03:00:00Z', undefined));
    const retry = syncRunId(CHAIN_ID, JOB, scheduledTimeFrom('2026-03-01T03:00:00Z', undefined));

    expect(retry).toBe(first);
  });

  it('gives a retry the same run whether the timestamp is offset or zulu', () => {
    // Cloud Scheduler sends an RFC 3339 timestamp; an operator replaying one by hand may write the
    // same instant differently. The same instant is the same tick.
    const zulu = syncRunId(CHAIN_ID, JOB, scheduledTimeFrom('2026-03-01T03:00:00Z', undefined));
    const offset = syncRunId(
      CHAIN_ID,
      JOB,
      scheduledTimeFrom('2026-03-01T00:00:00-03:00', undefined)
    );

    expect(offset).toBe(zulu);
  });

  it('gives the next day a run of its own', () => {
    const monday = syncRunId(CHAIN_ID, JOB, scheduledTimeFrom('2026-03-01T03:00:00Z', undefined));
    const tuesday = syncRunId(CHAIN_ID, JOB, scheduledTimeFrom('2026-03-02T03:00:00Z', undefined));

    expect(tuesday).not.toBe(monday);
  });

  it('would collapse every tick into one if the body won', () => {
    // The regression this ordering exists to prevent, stated as the thing that must not happen. Two
    // different deliveries, each carrying the fixed body a job would send, must still be two runs.
    const body = '2026-01-01T00:00:00Z';

    const monday = syncRunId(CHAIN_ID, JOB, scheduledTimeFrom('2026-03-01T03:00:00Z', body));
    const tuesday = syncRunId(CHAIN_ID, JOB, scheduledTimeFrom('2026-03-02T03:00:00Z', body));

    expect(tuesday).not.toBe(monday);
  });

  it('separates two jobs pointed at the same schedule', () => {
    const tick = scheduledTimeFrom('2026-03-01T03:00:00Z', undefined);

    expect(syncRunId(CHAIN_ID, 'cardano-staking-sync-canary', tick)).not.toBe(
      syncRunId(CHAIN_ID, JOB, tick)
    );
  });

  it('separates two chains on the same job name', () => {
    // A deployment moved from Preprod to Mainnet must not inherit the other network's run.
    const tick = scheduledTimeFrom('2026-03-01T03:00:00Z', undefined);

    expect(syncRunId(900_764_824_073, JOB, tick)).not.toBe(syncRunId(CHAIN_ID, JOB, tick));
  });

  it('gives two manual calls runs of their own', () => {
    // Nothing identifies them, so nothing should merge them: a hand-made call is not a tick, and
    // two of them sharing a run would mean the second silently did nothing.
    const first = syncRunId(CHAIN_ID, JOB, scheduledTimeFrom(undefined, undefined, new Date(1)));
    const second = syncRunId(CHAIN_ID, JOB, scheduledTimeFrom(undefined, undefined, new Date(2)));

    expect(second).not.toBe(first);
  });
});
