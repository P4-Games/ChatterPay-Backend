/**
 * The governance target a request names, read once and projected into every form the rest needs.
 *
 * A vote delegation is not one decision, it is two: *delegate my vote* and *delegate it to this*. The
 * action name carries the first. Until this module existed nothing carried the second, so
 * `delegate_vote` could only ever mean abstaining — the assembler's default — and the two other
 * targets Cardano offers were unreachable.
 *
 * What a request supplies is a tagged object, and it stays tagged all the way down rather than
 * becoming a string the reader has to classify. The alternative — one field holding either a
 * predefined keyword or a bech32 identifier — makes "which kind of target is this" an inference, and
 * an inference that goes wrong turns a mistyped identifier into a silent abstention.
 *
 * One read produces four projections, because four different consumers each need a different one and
 * none of them should re-derive it:
 *
 * - `drep` is what a certificate is built from: {@link CardanoDRepTarget}, the shape
 *   `cardanoCertificateService` already encodes.
 * - `canonical` is what the BFF assertion and the PIN grant are bound to. It is the whole point of
 *   the module: a grant issued for one target cannot be presented for another, because the target is
 *   inside the signature.
 * - `idCip129` is identity: the only form stored or compared, produced by the existing
 *   CIP-105/CIP-129 normaliser in `cardanoDRepIdService`. Nothing here parses bech32.
 * - `suppliedId` is the identifier exactly as it arrived, which is what `canonical` is built from.
 *
 * **Why `canonical` binds the supplied identifier rather than the canonical CIP-129 one.** The BFF
 * signs the same string, in its own process, and it has no DRep parser — duplicating one there is
 * how the two sides start disagreeing about what a DRep is. Binding the literal request field needs
 * no parser on either side and is strictly *tighter* than binding the normalised form: two spellings
 * of the same DRep produce two different canonical strings, so a grant is good for the spelling it
 * was issued for. That costs nothing, because a grant is issued and spent inside one flow carrying
 * one string, and it removes an entire class of "the two sides normalise differently" defect.
 *
 * The identifier is still parsed — by `cardanoDRepIdService`, further down — to build the certificate
 * and to compare against what the credential already delegates to. Refusing to guess is that
 * module's rule and it is this module's rule too: an identifier that does not decode is refused, not
 * silently turned into an abstention.
 */

import type {
  CardanoDRepCredential,
  CardanoGovernanceDelegation
} from '../../models/cardanoStakingAccountModel';
import type { CardanoStakingOperationKind } from '../../models/cardanoStakingOperationModel';
import type { CardanoDRepTarget } from './cardanoCertificateService';
import { parseDRepId, sameDRep } from './cardanoDRepIdService';

/** The three targets this surface offers. Nothing here registers a DRep or casts a vote. */
export const GOVERNANCE_TARGET_KINDS = ['always_abstain', 'always_no_confidence', 'drep'] as const;

/** Which of the three a request named. */
export type CardanoGovernanceTargetKind = (typeof GOVERNANCE_TARGET_KINDS)[number];

/** The actions that carry a governance target. Exactly one, and every other action refuses one. */
export const GOVERNANCE_TARGETED_ACTIONS: readonly CardanoStakingOperationKind[] = [
  'delegate_vote'
];

/**
 * The characters a DRep identifier may consist of before it is allowed into a signed string.
 *
 * Not a parser and not a substitute for one: `cardanoDRepIdService` still decides whether the
 * identifier denotes a DRep. This is a delimiter guard, and it is load-bearing for the signature.
 * The canonical form of an assertion joins its fields with `|`, which is safe only while no field
 * can contain one — so an identifier carrying `|`, or any other separator, could otherwise be chosen
 * to make one claim set canonicalise to the same string as a different claim set, and a signature
 * over that string would verify for both.
 *
 * Bech32 is lowercase alphanumeric; the underscore is here because the CIP-105 prefixes
 * `drep_vkh` and `drep_script` contain one.
 */
const CANONICAL_ID_PATTERN = /^[a-z0-9_]{8,200}$/;

/** Why a governance target was not accepted. */
export type GovernanceTargetRefusal =
  /** Not a target: not an object, or a `kind` that is not one of the three. */
  | 'malformed'
  /** `kind: 'drep'` with no identifier. */
  | 'missing_drep_id'
  /** The identifier carries characters that must never reach a signed canonical string. */
  | 'unsafe_drep_id'
  /** The identifier does not decode as a DRep. Unreadable, which is not the same as absent. */
  | 'unreadable_drep_id'
  /** A target was supplied for an action that has none. */
  | 'not_applicable'
  /** The action needs a target and none was supplied. */
  | 'required';

/** A governance target that was read, in every form the rest of the pipeline asks for. */
export interface ParsedGovernanceTarget {
  kind: CardanoGovernanceTargetKind;
  /** What a certificate is built from. */
  drep: CardanoDRepTarget;
  /** The credential, on a DRep target. `null` for the two predefined ones. */
  credential: CardanoDRepCredential | null;
  /** Canonical identity, CIP-129. The only form stored or compared. `null` for the predefined ones. */
  idCip129: string | null;
  /** The identifier exactly as the request carried it. `null` for the predefined ones. */
  suppliedId: string | null;
  /** What the BFF assertion and the PIN grant are bound to. */
  canonical: string;
}

export type GovernanceTargetResult =
  | { ok: true; target: ParsedGovernanceTarget | null }
  | { ok: false; refusal: GovernanceTargetRefusal; detail: string };

/** The wire shape, as the HTTP body carries it. Unvalidated: every field is checked below. */
interface GovernanceTargetBody {
  kind?: unknown;
  drep_id?: unknown;
}

/**
 * Reads the governance target a request named, against the action it named.
 *
 * Both halves of the rule are checked here rather than in each caller: the one targeted action
 * requires a target, and every other action refuses one. A parameter that is merely ignored where it
 * has no meaning is the kind that acquires one later by accident — the same reasoning the exit
 * destination is already validated with.
 *
 * @param raw - Whatever arrived in the request's `governance_target` field.
 * @param action - The action the request named.
 * @returns The target, `null` when the action has none, or a refusal.
 */
export function parseGovernanceTarget(
  raw: unknown,
  action: CardanoStakingOperationKind
): GovernanceTargetResult {
  const targeted = GOVERNANCE_TARGETED_ACTIONS.includes(action);
  const supplied = raw !== undefined && raw !== null;

  if (!targeted) {
    return supplied
      ? { ok: false, refusal: 'not_applicable', detail: action }
      : { ok: true, target: null };
  }
  if (!supplied) return { ok: false, refusal: 'required', detail: action };

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, refusal: 'malformed', detail: 'not an object' };
  }

  const body = raw as GovernanceTargetBody;
  const kind = body.kind;
  if (typeof kind !== 'string' || !isTargetKind(kind)) {
    return { ok: false, refusal: 'malformed', detail: `kind must be one of: ${kinds()}` };
  }

  if (kind !== 'drep') {
    return {
      ok: true,
      target: {
        kind,
        drep: { kind },
        credential: null,
        idCip129: null,
        suppliedId: null,
        canonical: kind
      }
    };
  }

  const drepId = typeof body.drep_id === 'string' ? body.drep_id.trim() : '';
  if (drepId === '')
    return { ok: false, refusal: 'missing_drep_id', detail: 'drep_id is required' };
  // Before anything else reads it, and before it can reach a signature.
  if (!CANONICAL_ID_PATTERN.test(drepId)) {
    return { ok: false, refusal: 'unsafe_drep_id', detail: 'drep_id is not a bare identifier' };
  }

  const parsed = parseDRepId(drepId);
  if (parsed === null) {
    return {
      ok: false,
      refusal: 'unreadable_drep_id',
      detail: 'drep_id does not decode as a DRep'
    };
  }

  return {
    ok: true,
    target: {
      kind: 'drep',
      drep: { kind: 'drep', credential: parsed.credential },
      credential: parsed.credential,
      idCip129: parsed.idCip129,
      suppliedId: drepId,
      canonical: `drep:${drepId}`
    }
  };
}

/**
 * What the assertion and the grant are bound to, for a target that may be absent.
 *
 * `null` rather than an empty string when there is no target, so that an action with no governance
 * meaning signs the same thing it always signed.
 *
 * @param target - The target, or `null`.
 * @returns The canonical string, or `null`.
 */
export function governanceTargetCanonical(target: ParsedGovernanceTarget | null): string | null {
  return target === null ? null : target.canonical;
}

/**
 * Whether a credential already delegates its vote exactly where the request asks for.
 *
 * A DRep is compared by what its identifier decodes to, never as text: the same DRep is spelled
 * three different ways across CIP-105, its revision and CIP-129, and comparing strings is how a
 * delegation to the DRep somebody already delegates to reads as a change worth a network fee.
 *
 * @param delegation - What the chain last reported, or `null` when nothing was read.
 * @param target - What is being asked for.
 * @returns `true` only when both are known and denote the same target.
 */
export function governanceTargetAlreadyInPlace(
  delegation: CardanoGovernanceDelegation | null,
  target: ParsedGovernanceTarget
): boolean {
  if (delegation === null) return false;
  if (target.kind !== 'drep') return delegation.kind === target.kind;
  if (delegation.kind !== 'drep') return false;
  return sameDRep(delegation.idCip129 ?? null, target.idCip129);
}

/**
 * Whether a string is one of the three target kinds.
 *
 * @param value - The candidate.
 * @returns `true` when it is.
 */
function isTargetKind(value: string): value is CardanoGovernanceTargetKind {
  return (GOVERNANCE_TARGET_KINDS as readonly string[]).includes(value);
}

/**
 * The kinds, for a refusal message.
 *
 * @returns The kinds, comma separated.
 */
function kinds(): string {
  return GOVERNANCE_TARGET_KINDS.join(', ');
}
