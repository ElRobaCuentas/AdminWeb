/**
 * PULSO tracking evaluator.
 *
 * Pure domain logic. It has no dependency on Firebase, Cloudflare, D1,
 * Telegram, React, timers or I/O. Every threshold is received as a parameter.
 */

export type SourceAccess = "available" | "unavailable";

/**
 * Fields that DriverApp publishes today in `/ubicacion_buses/{busId}`.
 */
export interface CurrentTrackingFields {
  readonly isActive?: boolean | null;
  /**
   * Publication time written on each update. Today DriverApp refreshes it even
   * when it republishes the previous GPS fix, so it does not prove a new fix.
   */
  readonly timestamp?: number | null;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  readonly heading?: number | null;
  readonly speed?: number | null;
}

export interface StopEvidence {
  /** Time of the explicit DETENER that closed the trip. */
  readonly stoppedAt: number;
}

/**
 * PULSO telemetry that DriverApp does not publish yet. These fields are
 * simulated in tests and will be incorporated in a later task.
 */
export interface PlannedTelemetryFields {
  readonly tripSessionId?: string | null;
  readonly tripStartAcceptedAt?: number | null;
  readonly stopEvidence?: StopEvidence | null;
  /** Identity of the GPS fix. A heartbeat that reuses the fix keeps it. */
  readonly gpsFixId?: string | null;
  /** Original GPS fix time, not the republication time. */
  readonly gpsFixTimestamp?: number | null;
  readonly serverReceivedAt?: number | null;
  readonly telemetryVersion?: number | null;
}

export interface TrackingObservation {
  /** Evaluation clock, milliseconds since the Unix epoch. */
  readonly evaluatedAt: number;
  readonly sourceAccess: SourceAccess;
  readonly current: CurrentTrackingFields;
  /** Absent while only today's fields are available. */
  readonly planned?: PlannedTelemetryFields;
}

export interface TrackingEvaluationConfig {
  /** Age above which an active trip's publication is considered interrupted. */
  readonly publicationStaleAfterMs: number;
  /** Distinct valid publications required to confirm a recovery. */
  readonly recoveryConfirmationsRequired: number;
  /** Tolerance for timestamps ahead of `evaluatedAt`. */
  readonly maxFutureSkewMs: number;
}

export type TrackingClassification =
  | "source-unavailable"
  | "insufficient-data"
  | "active-publishing"
  | "active-publication-stale"
  | "inactive-finalized"
  | "inactive-unconfirmed"
  | "recovering-pending"
  | "recovering-confirmed";

export type PublicationState = "fresh" | "stale" | "unknown";
export type GpsMeasurementState = "new" | "reused" | "unknown";
export type CoordinateState = "changed" | "repeated" | "unknown";
export type RecoveryState = "none" | "pending" | "confirmed";
export type FinalizationState = "not-applicable" | "confirmed" | "unconfirmed";
export type TripContinuity =
  | "initial"
  | "same"
  | "changed"
  | "legacy"
  | "mixed"
  | "unavailable";

export type EvaluationReasonCode =
  | "source-unavailable"
  | "trip-declaration-missing"
  | "trip-session-changed"
  | "trip-session-unknown"
  | "publication-timestamp-missing"
  | "publication-timestamp-invalid"
  | "publication-timestamp-ahead"
  | "publication-interrupted"
  | "contradictory-trip-state"
  | "recovery-pending"
  | "recovery-confirmed"
  | "recovery-reset-by-interruption"
  | "gps-fix-reused"
  | "gps-fix-identity-unavailable"
  | "gps-fix-timestamp-invalid"
  | "gps-measurement-unverifiable"
  | "coordinates-repeated"
  | "stop-evidence-missing"
  | "stop-evidence-invalid"
  | "stop-evidence-unverified"
  | "finalization-confirmed"
  | "finalization-unconfirmed";

/**
 * State produced by a previous evaluation. The caller passes the previous
 * result back to keep interruption and recovery continuity.
 */
export interface PriorTrackingState {
  readonly tripSessionId: string | null;
  readonly publicationInterrupted: boolean;
  readonly interruptionFirstObservedAt: number | null;
  readonly recoveryState: RecoveryState;
  readonly recoveryValidObservations: number;
  readonly lastRecoveryPublicationTimestamp: number | null;
  readonly lastGpsFixId: string | null;
  readonly lastGpsFixTimestamp: number | null;
  readonly lastLatitude: number | null;
  readonly lastLongitude: number | null;
}

export interface PublicationSummary {
  readonly state: PublicationState;
  readonly ageMs: number | null;
}

export interface GpsMeasurementSummary {
  readonly state: GpsMeasurementState;
  readonly fixId: string | null;
  readonly fixTimestamp: number | null;
  readonly fixAgeMs: number | null;
}

export interface TrackingEvaluation extends PriorTrackingState {
  readonly classification: TrackingClassification;
  readonly publication: PublicationSummary;
  readonly gpsMeasurement: GpsMeasurementSummary;
  readonly coordinates: CoordinateState;
  readonly finalization: FinalizationState;
  readonly reasons: readonly EvaluationReasonCode[];
}

export interface EvaluateTrackingInput {
  readonly observation: TrackingObservation;
  readonly previous?: PriorTrackingState | null;
  readonly config: TrackingEvaluationConfig;
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeActive(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeIdentifier(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCoordinate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function assertFiniteNumber(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number`);
  }
}

function assertConfig(config: TrackingEvaluationConfig): void {
  assertFiniteNumber(config.publicationStaleAfterMs, "publicationStaleAfterMs");
  if (config.publicationStaleAfterMs < 0) {
    throw new RangeError("publicationStaleAfterMs must be zero or greater");
  }

  assertFiniteNumber(config.maxFutureSkewMs, "maxFutureSkewMs");
  if (config.maxFutureSkewMs < 0) {
    throw new RangeError("maxFutureSkewMs must be zero or greater");
  }

  if (
    !Number.isInteger(config.recoveryConfirmationsRequired) ||
    config.recoveryConfirmationsRequired < 1
  ) {
    throw new RangeError(
      "recoveryConfirmationsRequired must be a positive integer",
    );
  }
}

export function evaluateTracking(
  input: EvaluateTrackingInput,
): TrackingEvaluation {
  const { observation, previous = null, config } = input;

  assertFiniteNumber(observation.evaluatedAt, "evaluatedAt");
  assertConfig(config);

  const reasons: EvaluationReasonCode[] = [];
  const now = observation.evaluatedAt;
  const sourceAvailable = observation.sourceAccess === "available";
  const active = sourceAvailable
    ? normalizeActive(observation.current.isActive)
    : null;
  const planned = sourceAvailable ? observation.planned : undefined;

  const currentTripSessionId = normalizeIdentifier(planned?.tripSessionId);
  const priorTripSessionId = previous?.tripSessionId ?? null;

  let tripContinuity: TripContinuity;
  let tripSessionId: string | null;
  let scopedPrevious: PriorTrackingState | null = previous;

  if (!sourceAvailable) {
    tripContinuity = "unavailable";
    tripSessionId = priorTripSessionId;
  } else if (previous === null) {
    tripContinuity = "initial";
    tripSessionId = currentTripSessionId;
  } else if (priorTripSessionId !== null && currentTripSessionId !== null) {
    tripContinuity =
      priorTripSessionId === currentTripSessionId ? "same" : "changed";
    tripSessionId = currentTripSessionId;
  } else if (priorTripSessionId === null && currentTripSessionId === null) {
    tripContinuity = "legacy";
    tripSessionId = null;
  } else {
    tripContinuity = "mixed";
    tripSessionId = currentTripSessionId ?? priorTripSessionId;
  }

  if (tripContinuity === "changed") {
    reasons.push("trip-session-changed");
    scopedPrevious = null;
  } else if (tripContinuity === "legacy" || tripContinuity === "mixed") {
    reasons.push("trip-session-unknown");
    if (tripContinuity === "mixed") {
      scopedPrevious = null;
    }
  }

  const prior = scopedPrevious;

  let publicationState: PublicationState = "unknown";
  let publicationAgeMs: number | null = null;
  let publicationTimestamp: number | null = null;

  if (!sourceAvailable) {
    reasons.push("source-unavailable");
  } else if (active === null) {
    reasons.push("trip-declaration-missing");
  } else if (active === true) {
    const rawTimestamp = observation.current.timestamp;

    if (rawTimestamp === null || rawTimestamp === undefined) {
      reasons.push("publication-timestamp-missing");
    } else if (!isValidTimestamp(rawTimestamp)) {
      reasons.push("publication-timestamp-invalid");
    } else if (rawTimestamp - now > config.maxFutureSkewMs) {
      reasons.push("publication-timestamp-ahead");
    } else {
      publicationTimestamp = rawTimestamp;
      publicationAgeMs = Math.max(0, now - rawTimestamp);
      publicationState =
        publicationAgeMs > config.publicationStaleAfterMs ? "stale" : "fresh";

      if (publicationState === "stale") {
        reasons.push("publication-interrupted");
      }
    }
  }

  const rawStopEvidence = planned?.stopEvidence ?? null;
  const stopEvidencePresent = rawStopEvidence !== null;
  const stopEvidenceTimestampValid =
    rawStopEvidence !== null &&
    isValidTimestamp(rawStopEvidence.stoppedAt) &&
    rawStopEvidence.stoppedAt - now <= config.maxFutureSkewMs;
  const stopEvidenceTripVerified = tripContinuity === "same";
  const stopEvidenceEffective =
    stopEvidencePresent && stopEvidenceTimestampValid && stopEvidenceTripVerified;

  let stopEvidenceIssue: "missing" | "invalid" | "unverified" | null = null;
  if (!stopEvidencePresent) {
    stopEvidenceIssue = "missing";
  } else if (!stopEvidenceTimestampValid) {
    stopEvidenceIssue = "invalid";
  } else if (!stopEvidenceTripVerified) {
    stopEvidenceIssue = "unverified";
  }

  const contradictoryTripState = active === true && stopEvidenceEffective;

  if (contradictoryTripState) {
    reasons.push("contradictory-trip-state");
  } else if (active === true && stopEvidenceIssue === "invalid") {
    reasons.push("stop-evidence-invalid");
  } else if (active === true && stopEvidenceIssue === "unverified") {
    reasons.push("stop-evidence-unverified");
  }

  const currentFixId = normalizeIdentifier(planned?.gpsFixId);
  const rawFixTimestamp = planned?.gpsFixTimestamp ?? null;
  let currentFixTimestamp: number | null = null;
  let gpsFixTimestampInvalid = false;

  if (rawFixTimestamp !== null) {
    if (
      isValidTimestamp(rawFixTimestamp) &&
      rawFixTimestamp - now <= config.maxFutureSkewMs
    ) {
      currentFixTimestamp = rawFixTimestamp;
    } else {
      gpsFixTimestampInvalid = true;
    }
  }

  const priorFixId = prior?.lastGpsFixId ?? null;
  const priorFixTimestamp = prior?.lastGpsFixTimestamp ?? null;
  const hasCurrentMeasurement =
    currentFixId !== null || currentFixTimestamp !== null;
  const hasPriorMeasurement = priorFixId !== null || priorFixTimestamp !== null;

  let gpsMeasurementState: GpsMeasurementState = "unknown";
  let gpsUnknownReason:
    | "identity-unavailable"
    | "measurement-unverifiable"
    | null = null;

  if (currentFixId !== null && priorFixId !== null) {
    gpsMeasurementState = currentFixId === priorFixId ? "reused" : "new";
  } else if (currentFixTimestamp !== null && priorFixTimestamp !== null) {
    gpsMeasurementState =
      currentFixTimestamp === priorFixTimestamp ? "reused" : "new";
  } else if (!hasPriorMeasurement && hasCurrentMeasurement) {
    gpsMeasurementState = "new";
  } else if (hasPriorMeasurement && hasCurrentMeasurement) {
    gpsMeasurementState = "unknown";
    gpsUnknownReason = "measurement-unverifiable";
  } else {
    gpsMeasurementState = "unknown";
    gpsUnknownReason = "identity-unavailable";
  }

  if (active === true) {
    if (gpsMeasurementState === "reused") {
      reasons.push("gps-fix-reused");
    } else if (gpsMeasurementState === "unknown") {
      reasons.push(
        gpsUnknownReason === "measurement-unverifiable"
          ? "gps-measurement-unverifiable"
          : "gps-fix-identity-unavailable",
      );
    }

    if (gpsFixTimestampInvalid) {
      reasons.push("gps-fix-timestamp-invalid");
    }
  }

  const gpsFixAgeMs =
    currentFixTimestamp !== null ? Math.max(0, now - currentFixTimestamp) : null;

  const currentLatitude = sourceAvailable
    ? normalizeCoordinate(observation.current.latitude)
    : null;
  const currentLongitude = sourceAvailable
    ? normalizeCoordinate(observation.current.longitude)
    : null;
  const hasCurrentCoordinates =
    currentLatitude !== null && currentLongitude !== null;
  const priorLatitude = prior?.lastLatitude ?? null;
  const priorLongitude = prior?.lastLongitude ?? null;
  const hasPriorCoordinates = priorLatitude !== null && priorLongitude !== null;

  let coordinatesState: CoordinateState = "unknown";

  if (hasCurrentCoordinates && hasPriorCoordinates) {
    coordinatesState =
      currentLatitude === priorLatitude && currentLongitude === priorLongitude
        ? "repeated"
        : "changed";

    if (active === true && coordinatesState === "repeated") {
      reasons.push("coordinates-repeated");
    }
  }

  let finalization: FinalizationState = "not-applicable";

  if (sourceAvailable && active === false) {
    if (stopEvidenceEffective) {
      finalization = "confirmed";
      reasons.push("finalization-confirmed");
    } else {
      finalization = "unconfirmed";
      reasons.push("finalization-unconfirmed");

      if (stopEvidenceIssue === "missing") {
        reasons.push("stop-evidence-missing");
      } else if (stopEvidenceIssue === "invalid") {
        reasons.push("stop-evidence-invalid");
      } else if (stopEvidenceIssue === "unverified") {
        reasons.push("stop-evidence-unverified");
      }
    }
  }

  let publicationInterrupted = false;
  let interruptionFirstObservedAt: number | null = null;
  const cannotDetermineCurrentState =
    !sourceAvailable ||
    active === null ||
    contradictoryTripState ||
    (active === true && publicationState === "unknown");

  if (active === true && publicationState === "stale") {
    publicationInterrupted = true;
    interruptionFirstObservedAt =
      prior?.publicationInterrupted === true &&
      prior.interruptionFirstObservedAt !== null
        ? prior.interruptionFirstObservedAt
        : now;
  } else if (
    cannotDetermineCurrentState &&
    prior?.publicationInterrupted === true
  ) {
    publicationInterrupted = true;
    interruptionFirstObservedAt = prior.interruptionFirstObservedAt;
  }

  const priorRecoveryState = prior?.recoveryState ?? "none";
  const priorRecoveryCount = prior?.recoveryValidObservations ?? 0;
  const priorRecoveryLastTimestamp =
    prior?.lastRecoveryPublicationTimestamp ?? null;

  let recoveryState: RecoveryState = "none";
  let recoveryValidObservations = 0;
  let lastRecoveryPublicationTimestamp: number | null = null;

  if (cannotDetermineCurrentState) {
    if (priorRecoveryState === "pending") {
      recoveryState = "pending";
      recoveryValidObservations = priorRecoveryCount;
      lastRecoveryPublicationTimestamp = priorRecoveryLastTimestamp;
    }
  } else if (active === false) {
    // The trip ended; recovery is not applicable.
  } else if (publicationState === "stale") {
    if (priorRecoveryState === "pending") {
      reasons.push("recovery-reset-by-interruption");
    }
  } else if (publicationState === "fresh" && publicationTimestamp !== null) {
    const wasInterrupted = prior?.publicationInterrupted === true;

    if (priorRecoveryState === "pending" || wasInterrupted) {
      const isDistinct =
        priorRecoveryLastTimestamp === null ||
        publicationTimestamp > priorRecoveryLastTimestamp;

      recoveryValidObservations = isDistinct
        ? priorRecoveryCount + 1
        : priorRecoveryCount;
      lastRecoveryPublicationTimestamp = isDistinct
        ? publicationTimestamp
        : priorRecoveryLastTimestamp;

      if (
        recoveryValidObservations >= config.recoveryConfirmationsRequired
      ) {
        recoveryState = "confirmed";
        reasons.push("recovery-confirmed");
      } else {
        recoveryState = "pending";
        reasons.push("recovery-pending");
      }
    }
  }

  let classification: TrackingClassification;

  if (!sourceAvailable) {
    classification = "source-unavailable";
  } else if (active === null || contradictoryTripState) {
    classification = "insufficient-data";
  } else if (active === false) {
    classification = stopEvidenceEffective
      ? "inactive-finalized"
      : "inactive-unconfirmed";
  } else if (publicationState === "stale") {
    classification = "active-publication-stale";
  } else if (publicationState === "unknown") {
    classification = "insufficient-data";
  } else if (recoveryState === "confirmed") {
    classification = "recovering-confirmed";
  } else if (recoveryState === "pending") {
    classification = "recovering-pending";
  } else {
    classification = "active-publishing";
  }

  let lastGpsFixId: string | null;
  let lastGpsFixTimestamp: number | null;

  if (currentFixId !== null && currentFixTimestamp !== null) {
    lastGpsFixId = currentFixId;
    lastGpsFixTimestamp = currentFixTimestamp;
  } else if (currentFixId !== null) {
    lastGpsFixId = currentFixId;
    lastGpsFixTimestamp = null;
  } else if (currentFixTimestamp !== null) {
    lastGpsFixId = null;
    lastGpsFixTimestamp = currentFixTimestamp;
  } else {
    lastGpsFixId = priorFixId;
    lastGpsFixTimestamp = priorFixTimestamp;
  }

  const lastLatitude = hasCurrentCoordinates ? currentLatitude : priorLatitude;
  const lastLongitude = hasCurrentCoordinates
    ? currentLongitude
    : priorLongitude;

  return {
    tripSessionId,
    classification,
    publication: {
      state: publicationState,
      ageMs: publicationAgeMs,
    },
    gpsMeasurement: {
      state: gpsMeasurementState,
      fixId: currentFixId,
      fixTimestamp: currentFixTimestamp,
      fixAgeMs: gpsFixAgeMs,
    },
    coordinates: coordinatesState,
    finalization,
    publicationInterrupted,
    interruptionFirstObservedAt,
    recoveryState,
    recoveryValidObservations,
    lastRecoveryPublicationTimestamp,
    lastGpsFixId,
    lastGpsFixTimestamp,
    lastLatitude,
    lastLongitude,
    reasons,
  };
}
