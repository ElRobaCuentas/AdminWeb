import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateTracking } from "../src/domain/evaluateTracking.ts";
import type {
  CurrentTrackingFields,
  PlannedTelemetryFields,
  PriorTrackingState,
  SourceAccess,
  TrackingEvaluation,
  TrackingEvaluationConfig,
  TrackingObservation,
} from "../src/domain/evaluateTracking.ts";

const NOW = 1_700_000_000_000;

const CONFIG: TrackingEvaluationConfig = Object.freeze({
  publicationStaleAfterMs: 180_000,
  recoveryConfirmationsRequired: 2,
  maxFutureSkewMs: 300_000,
});

interface ObservationOverrides {
  readonly evaluatedAt?: number;
  readonly sourceAccess?: SourceAccess;
  readonly current?: Partial<CurrentTrackingFields>;
  readonly planned?: PlannedTelemetryFields | null;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }

  return value;
}

function makeObservation(
  overrides: ObservationOverrides = {},
): TrackingObservation {
  const observation: TrackingObservation = {
    evaluatedAt: overrides.evaluatedAt ?? NOW,
    sourceAccess: overrides.sourceAccess ?? "available",
    current: {
      isActive: true,
      timestamp: NOW - 10_000,
      latitude: -31.4201,
      longitude: -64.1888,
      ...overrides.current,
    },
    ...(overrides.planned == null ? {} : { planned: overrides.planned }),
  };

  return deepFreeze(observation);
}

function tripObservation(
  tripSessionId: string | null,
  overrides: ObservationOverrides = {},
): TrackingObservation {
  return makeObservation({
    ...overrides,
    planned: {
      ...(overrides.planned ?? {}),
      tripSessionId,
    },
  });
}

function evaluate(
  observation: TrackingObservation,
  previous: PriorTrackingState | null = null,
  config: TrackingEvaluationConfig = CONFIG,
): TrackingEvaluation {
  return evaluateTracking({ observation, previous, config });
}

function staleObservation(evaluatedAt = NOW): TrackingObservation {
  return makeObservation({
    evaluatedAt,
    current: {
      timestamp: NOW - CONFIG.publicationStaleAfterMs - 1,
    },
  });
}

describe("publicación y medición GPS", () => {
  it("clasifica un recorrido activo con publicación reciente y medición GPS nueva", () => {
    const result = evaluate(
      makeObservation({
        current: { timestamp: NOW - 10_000 },
        planned: { gpsFixId: "fix-1", gpsFixTimestamp: NOW - 15_000 },
      }),
    );

    assert.equal(result.classification, "active-publishing");
    assert.deepEqual(result.publication, { state: "fresh", ageMs: 10_000 });
    assert.equal(result.gpsMeasurement.state, "new");
    assert.equal(result.gpsMeasurement.fixAgeMs, 15_000);
    assert.equal(result.coordinates, "unknown");
    assert.equal(result.finalization, "not-applicable");
    assert.equal(result.recoveryState, "none");
  });

  it("trata el umbral exacto como vigente y lo superado como vencido", () => {
    const before = evaluate(
      makeObservation({
        current: { timestamp: NOW - CONFIG.publicationStaleAfterMs + 1 },
      }),
    );
    const exact = evaluate(
      makeObservation({
        current: { timestamp: NOW - CONFIG.publicationStaleAfterMs },
      }),
    );
    const after = evaluate(
      makeObservation({
        current: { timestamp: NOW - CONFIG.publicationStaleAfterMs - 1 },
      }),
    );

    assert.equal(before.publication.state, "fresh");
    assert.equal(exact.publication.state, "fresh");
    assert.equal(exact.classification, "active-publishing");
    assert.equal(after.publication.state, "stale");
    assert.equal(after.classification, "active-publication-stale");
  });

  it("persiste la interrupción y conserva cuándo se observó por primera vez", () => {
    const first = evaluate(staleObservation());

    assert.equal(first.classification, "active-publication-stale");
    assert.equal(first.publicationInterrupted, true);
    assert.equal(first.interruptionFirstObservedAt, NOW);

    const second = evaluate(
      makeObservation({
        evaluatedAt: NOW + 60_000,
        current: {
          timestamp: NOW - CONFIG.publicationStaleAfterMs - 1,
        },
      }),
      first,
    );

    assert.equal(second.classification, "active-publication-stale");
    assert.equal(second.publicationInterrupted, true);
    assert.equal(second.interruptionFirstObservedAt, NOW);
    assert.ok(second.reasons.includes("publication-interrupted"));
  });

  it("detecta una publicación reciente que reutiliza una medición GPS anterior", () => {
    const first = evaluate(
      makeObservation({
        current: { timestamp: NOW - 20_000 },
        planned: { gpsFixId: "fix-1", gpsFixTimestamp: NOW - 25_000 },
      }),
    );

    const second = evaluate(
      makeObservation({
        evaluatedAt: NOW + 60_000,
        current: { timestamp: NOW + 50_000 },
        planned: { gpsFixId: "fix-1", gpsFixTimestamp: NOW - 25_000 },
      }),
      first,
    );

    assert.equal(second.classification, "active-publishing");
    assert.deepEqual(second.publication, { state: "fresh", ageMs: 10_000 });
    assert.equal(second.gpsMeasurement.state, "reused");
    assert.equal(second.gpsMeasurement.fixAgeMs, 85_000);
    assert.ok(second.reasons.includes("gps-fix-reused"));
  });

  it("no interpreta coordenadas repetidas como avería cuando la medición es nueva", () => {
    const first = evaluate(
      makeObservation({ planned: { gpsFixId: "fix-1" } }),
    );

    const second = evaluate(
      makeObservation({
        evaluatedAt: NOW + 60_000,
        current: { timestamp: NOW + 50_000 },
        planned: { gpsFixId: "fix-2" },
      }),
      first,
    );

    assert.equal(second.classification, "active-publishing");
    assert.equal(second.gpsMeasurement.state, "new");
    assert.equal(second.coordinates, "repeated");
    assert.ok(second.reasons.includes("coordinates-repeated"));
    assert.ok(!second.reasons.includes("publication-interrupted"));
  });

  it("afirma coordenadas modificadas sin emitir la razón de repetición", () => {
    const first = evaluate(
      makeObservation({ planned: { gpsFixId: "fix-1" } }),
    );

    const second = evaluate(
      makeObservation({
        evaluatedAt: NOW + 60_000,
        current: {
          timestamp: NOW + 50_000,
          latitude: -31.421_2,
          longitude: -64.189_1,
        },
        planned: { gpsFixId: "fix-2" },
      }),
      first,
    );

    assert.equal(second.coordinates, "changed");
    assert.ok(!second.reasons.includes("coordinates-repeated"));
  });

  it("deja la medición GPS como desconocida cuando solo existen los campos actuales", () => {
    const result = evaluate(
      makeObservation({
        current: { timestamp: NOW - 10_000 },
        planned: null,
      }),
    );

    assert.equal(result.classification, "active-publishing");
    assert.deepEqual(result.gpsMeasurement, {
      state: "unknown",
      fixId: null,
      fixTimestamp: null,
      fixAgeMs: null,
    });
    assert.ok(result.reasons.includes("gps-fix-identity-unavailable"));
  });

  it("compara mediciones GPS solo por timestamp cuando falta el identificador", () => {
    const first = evaluate(
      makeObservation({ planned: { gpsFixTimestamp: NOW - 30_000 } }),
    );

    const reused = evaluate(
      makeObservation({
        evaluatedAt: NOW + 60_000,
        current: { timestamp: NOW + 50_000 },
        planned: { gpsFixTimestamp: NOW - 30_000 },
      }),
      first,
    );

    assert.equal(reused.gpsMeasurement.state, "reused");
    assert.ok(reused.reasons.includes("gps-fix-reused"));

    const fresh = evaluate(
      makeObservation({
        evaluatedAt: NOW + 60_000,
        current: { timestamp: NOW + 50_000 },
        planned: { gpsFixTimestamp: NOW - 20_000 },
      }),
      first,
    );

    assert.equal(fresh.gpsMeasurement.state, "new");
  });

  it("declara la medición no verificable cuando previa y actual no comparten dimensión", () => {
    const first = evaluate(
      makeObservation({ planned: { gpsFixId: "fix-1" } }),
    );

    const second = evaluate(
      makeObservation({
        evaluatedAt: NOW + 60_000,
        current: { timestamp: NOW + 50_000 },
        planned: { gpsFixTimestamp: NOW - 20_000 },
      }),
      first,
    );

    assert.equal(second.gpsMeasurement.state, "unknown");
    assert.ok(second.reasons.includes("gps-measurement-unverifiable"));
    assert.ok(!second.reasons.includes("gps-fix-identity-unavailable"));
  });

  it("declara la medición no verificable cuando la actual solo aporta identificador", () => {
    const first = evaluate(
      makeObservation({ planned: { gpsFixTimestamp: NOW - 30_000 } }),
    );

    const second = evaluate(
      makeObservation({
        evaluatedAt: NOW + 60_000,
        current: { timestamp: NOW + 50_000 },
        planned: { gpsFixId: "fix-1" },
      }),
      first,
    );

    assert.equal(second.gpsMeasurement.state, "unknown");
    assert.ok(second.reasons.includes("gps-measurement-unverifiable"));
  });

  it("ignora identificadores vacíos o en blanco", () => {
    const result = evaluate(
      makeObservation({
        planned: { tripSessionId: "   ", gpsFixId: "   " },
      }),
    );

    assert.equal(result.tripSessionId, null);
    assert.equal(result.gpsMeasurement.fixId, null);
    assert.ok(result.reasons.includes("gps-fix-identity-unavailable"));
  });

  it("ignora coordenadas no numéricas en lugar de afirmar un cambio", () => {
    const first = evaluate(
      makeObservation({
        current: { latitude: -31.4201, longitude: -64.1888 },
      }),
    );

    for (const latitude of [null, Number.NaN]) {
      const second = evaluate(
        makeObservation({
          evaluatedAt: NOW + 60_000,
          current: { timestamp: NOW + 50_000, latitude },
        }),
        first,
      );

      assert.equal(second.coordinates, "unknown");
      assert.ok(!second.reasons.includes("coordinates-repeated"));
    }
  });

  it("actualiza identificador y timestamp GPS como una unidad coherente", () => {
    const first = evaluate(
      makeObservation({
        planned: { gpsFixId: "fix-1", gpsFixTimestamp: NOW - 30_000 },
      }),
    );

    assert.equal(first.lastGpsFixId, "fix-1");
    assert.equal(first.lastGpsFixTimestamp, NOW - 30_000);

    const idOnly = evaluate(
      makeObservation({
        evaluatedAt: NOW + 60_000,
        current: { timestamp: NOW + 50_000 },
        planned: { gpsFixId: "fix-1" },
      }),
      first,
    );

    assert.equal(idOnly.gpsMeasurement.state, "reused");
    assert.equal(idOnly.lastGpsFixId, "fix-1");
    assert.equal(idOnly.lastGpsFixTimestamp, null);
  });

  it("invalida un timestamp GPS inválido o demasiado futuro", () => {
    const invalid = evaluate(
      makeObservation({
        planned: { gpsFixId: "fix-1", gpsFixTimestamp: Number.NaN },
      }),
    );

    assert.equal(invalid.gpsMeasurement.fixTimestamp, null);
    assert.equal(invalid.lastGpsFixTimestamp, null);
    assert.ok(invalid.reasons.includes("gps-fix-timestamp-invalid"));

    const ahead = evaluate(
      makeObservation({
        planned: { gpsFixTimestamp: NOW + CONFIG.maxFutureSkewMs + 1 },
      }),
    );

    assert.equal(ahead.gpsMeasurement.fixTimestamp, null);
    assert.ok(ahead.reasons.includes("gps-fix-timestamp-invalid"));
  });
});

describe("continuidad de jornada", () => {
  it("conserva la interrupción cuando la jornada sigue siendo la misma", () => {
    const first = evaluate(
      tripObservation("trip-1", {
        current: { timestamp: NOW - CONFIG.publicationStaleAfterMs - 1 },
      }),
    );

    assert.equal(first.tripSessionId, "trip-1");
    assert.equal(first.publicationInterrupted, true);

    const unknown = evaluate(
      tripObservation("trip-1", {
        evaluatedAt: NOW + 60_000,
        current: { isActive: null },
      }),
      first,
    );

    assert.equal(unknown.classification, "insufficient-data");
    assert.equal(unknown.publicationInterrupted, true);
    assert.equal(unknown.interruptionFirstObservedAt, NOW);
    assert.ok(!unknown.reasons.includes("trip-session-unknown"));
  });

  it("continúa la recuperación dentro de la misma jornada", () => {
    const interrupted = evaluate(
      tripObservation("trip-1", {
        current: { timestamp: NOW - CONFIG.publicationStaleAfterMs - 1 },
      }),
    );

    const pending = evaluate(
      tripObservation("trip-1", {
        evaluatedAt: NOW + 60_000,
        current: { timestamp: NOW + 50_000 },
      }),
      interrupted,
    );

    assert.equal(pending.recoveryState, "pending");

    const confirmed = evaluate(
      tripObservation("trip-1", {
        evaluatedAt: NOW + 120_000,
        current: { timestamp: NOW + 110_000 },
      }),
      pending,
    );

    assert.equal(confirmed.recoveryState, "confirmed");
    assert.equal(confirmed.recoveryValidObservations, 2);
  });

  it("reinicia interrupción, recuperación, GPS y coordenadas al cambiar de jornada", () => {
    const interrupted = evaluate(
      tripObservation("trip-1", {
        current: {
          timestamp: NOW - CONFIG.publicationStaleAfterMs - 1,
          latitude: -31.4201,
          longitude: -64.1888,
        },
        planned: { gpsFixId: "fix-1", gpsFixTimestamp: NOW - 200_000 },
      }),
    );

    assert.equal(interrupted.publicationInterrupted, true);

    const next = evaluate(
      tripObservation("trip-2", {
        evaluatedAt: NOW + 60_000,
        current: {
          timestamp: NOW + 50_000,
          latitude: -31.4201,
          longitude: -64.1888,
        },
        planned: { gpsFixId: "fix-1", gpsFixTimestamp: NOW - 200_000 },
      }),
      interrupted,
    );

    assert.equal(next.classification, "active-publishing");
    assert.equal(next.tripSessionId, "trip-2");
    assert.equal(next.publicationInterrupted, false);
    assert.equal(next.interruptionFirstObservedAt, null);
    assert.equal(next.gpsMeasurement.state, "new");
    assert.equal(next.coordinates, "unknown");
    assert.ok(next.reasons.includes("trip-session-changed"));
  });

  it("no reutiliza una recuperación pendiente de otra jornada", () => {
    const interrupted = evaluate(
      tripObservation("trip-1", {
        current: { timestamp: NOW - CONFIG.publicationStaleAfterMs - 1 },
      }),
    );

    const pending = evaluate(
      tripObservation("trip-1", {
        evaluatedAt: NOW + 60_000,
        current: { timestamp: NOW + 50_000 },
      }),
      interrupted,
    );

    assert.equal(pending.recoveryState, "pending");

    const changed = evaluate(
      tripObservation("trip-2", {
        evaluatedAt: NOW + 120_000,
        current: { timestamp: NOW + 110_000 },
      }),
      pending,
    );

    assert.equal(changed.recoveryState, "none");
    assert.equal(changed.recoveryValidObservations, 0);
    assert.ok(changed.reasons.includes("trip-session-changed"));
  });

  it("trata una identidad de jornada parcialmente conocida como desconocida y reinicia el estado", () => {
    const legacy = evaluate(staleObservation());

    assert.equal(legacy.tripSessionId, null);
    assert.equal(legacy.publicationInterrupted, true);

    const mixed = evaluate(
      tripObservation("trip-1", {
        evaluatedAt: NOW + 60_000,
        current: { timestamp: NOW + 50_000 },
      }),
      legacy,
    );

    assert.equal(mixed.tripSessionId, "trip-1");
    assert.equal(mixed.publicationInterrupted, false);
    assert.ok(mixed.reasons.includes("trip-session-unknown"));
    assert.ok(!mixed.reasons.includes("trip-session-changed"));
  });

  it("trata como desconocida la desaparición de la identidad y conserva la última conocida", () => {
    const identified = evaluate(
      tripObservation("trip-1", {
        current: { timestamp: NOW - CONFIG.publicationStaleAfterMs - 1 },
      }),
    );

    assert.equal(identified.publicationInterrupted, true);

    const result = evaluate(
      makeObservation({
        evaluatedAt: NOW + 60_000,
        current: { timestamp: NOW + 50_000 },
        planned: { gpsFixId: "fix-1" },
      }),
      identified,
    );

    assert.equal(result.tripSessionId, "trip-1");
    assert.equal(result.publicationInterrupted, false);
    assert.ok(result.reasons.includes("trip-session-unknown"));
  });

  it("conserva el estado cuando ambas observaciones carecen de identidad de jornada", () => {
    const interrupted = evaluate(staleObservation());

    const next = evaluate(
      makeObservation({
        evaluatedAt: NOW + 60_000,
        current: { timestamp: NOW + 50_000 },
      }),
      interrupted,
    );

    assert.equal(next.tripSessionId, null);
    assert.equal(next.recoveryState, "pending");
    assert.equal(next.recoveryValidObservations, 1);
    assert.ok(next.reasons.includes("trip-session-unknown"));
  });

  it("conserva interrupción, recuperación y jornada cuando la fuente no está disponible", () => {
    const interrupted = evaluate(
      tripObservation("trip-1", {
        current: { timestamp: NOW - CONFIG.publicationStaleAfterMs - 1 },
      }),
    );

    const unavailable = evaluate(
      makeObservation({
        evaluatedAt: NOW + 60_000,
        sourceAccess: "unavailable",
      }),
      interrupted,
    );

    assert.equal(unavailable.classification, "source-unavailable");
    assert.equal(unavailable.tripSessionId, "trip-1");
    assert.equal(unavailable.publicationInterrupted, true);
    assert.equal(unavailable.interruptionFirstObservedAt, NOW);

    const pending = evaluate(
      tripObservation("trip-1", {
        evaluatedAt: NOW + 120_000,
        current: { timestamp: NOW + 110_000 },
      }),
      interrupted,
    );

    assert.equal(pending.recoveryState, "pending");

    const unavailableDuringRecovery = evaluate(
      makeObservation({
        evaluatedAt: NOW + 180_000,
        sourceAccess: "unavailable",
      }),
      pending,
    );

    assert.equal(unavailableDuringRecovery.recoveryState, "pending");
    assert.equal(unavailableDuringRecovery.recoveryValidObservations, 1);
  });
});

describe("fuente e información insuficiente", () => {
  it("clasifica fuente inaccesible aunque la observación anterior fuera saludable", () => {
    const healthy = evaluate(
      makeObservation({
        planned: { gpsFixId: "fix-1", gpsFixTimestamp: NOW - 10_000 },
      }),
    );

    const unavailable = evaluate(
      makeObservation({
        evaluatedAt: NOW + 60_000,
        sourceAccess: "unavailable",
        current: { isActive: true, timestamp: NOW + 50_000 },
      }),
      healthy,
    );

    assert.equal(unavailable.classification, "source-unavailable");
    assert.equal(unavailable.publication.state, "unknown");
    assert.equal(unavailable.finalization, "not-applicable");
    assert.equal(unavailable.lastGpsFixId, "fix-1");
    assert.ok(unavailable.reasons.includes("source-unavailable"));
  });

  it("marca información insuficiente cuando falta la declaración del recorrido", () => {
    const result = evaluate(
      makeObservation({ current: { isActive: null } }),
    );

    assert.equal(result.classification, "insufficient-data");
    assert.ok(result.reasons.includes("trip-declaration-missing"));
  });

  it("distingue un timestamp de publicación ausente de uno inválido", () => {
    const missing = evaluate(
      makeObservation({ current: { timestamp: null } }),
    );

    assert.equal(missing.classification, "insufficient-data");
    assert.ok(missing.reasons.includes("publication-timestamp-missing"));
    assert.ok(!missing.reasons.includes("publication-timestamp-invalid"));

    for (const timestamp of [Number.NaN, 0, -1]) {
      const invalid = evaluate(
        makeObservation({ current: { timestamp } }),
      );

      assert.equal(invalid.classification, "insufficient-data");
      assert.ok(invalid.reasons.includes("publication-timestamp-invalid"));
      assert.ok(!invalid.reasons.includes("publication-timestamp-missing"));
    }
  });

  it("tolera un timestamp levemente futuro y rechaza uno que excede el margen", () => {
    const withinSkew = evaluate(
      makeObservation({
        current: { timestamp: NOW + CONFIG.maxFutureSkewMs },
      }),
    );
    const beyondSkew = evaluate(
      makeObservation({
        current: { timestamp: NOW + CONFIG.maxFutureSkewMs + 1 },
      }),
    );

    assert.equal(withinSkew.classification, "active-publishing");
    assert.equal(withinSkew.publication.ageMs, 0);
    assert.equal(beyondSkew.classification, "insufficient-data");
    assert.ok(beyondSkew.reasons.includes("publication-timestamp-ahead"));
  });

  it("solo contradice la declaración activa con evidencia de DETENER de la misma jornada", () => {
    const activeTrip = evaluate(tripObservation("trip-1"));

    const result = evaluate(
      tripObservation("trip-1", {
        current: { isActive: true, timestamp: NOW - 10_000 },
        planned: { stopEvidence: { stoppedAt: NOW - 5_000 } },
      }),
      activeTrip,
    );

    assert.equal(result.classification, "insufficient-data");
    assert.ok(result.reasons.includes("contradictory-trip-state"));
  });

  it("no contradice la declaración activa con evidencia inválida", () => {
    const activeTrip = evaluate(tripObservation("trip-1"));

    const result = evaluate(
      tripObservation("trip-1", {
        current: { isActive: true, timestamp: NOW - 10_000 },
        planned: { stopEvidence: { stoppedAt: Number.NaN } },
      }),
      activeTrip,
    );

    assert.equal(result.classification, "active-publishing");
    assert.ok(result.reasons.includes("stop-evidence-invalid"));
    assert.ok(!result.reasons.includes("contradictory-trip-state"));
  });

  it("no contradice la declaración activa con evidencia de otra jornada", () => {
    const activeTrip = evaluate(tripObservation("trip-1"));

    const result = evaluate(
      tripObservation("trip-2", {
        current: { isActive: true, timestamp: NOW - 10_000 },
        planned: { stopEvidence: { stoppedAt: NOW - 5_000 } },
      }),
      activeTrip,
    );

    assert.equal(result.classification, "active-publishing");
    assert.ok(result.reasons.includes("stop-evidence-unverified"));
    assert.ok(result.reasons.includes("trip-session-changed"));
    assert.ok(!result.reasons.includes("contradictory-trip-state"));
  });
});

describe("recorrido inactivo y finalización", () => {
  it("declara inactivo sin evidencia de DETENER como no finalizado", () => {
    const result = evaluate(
      makeObservation({ current: { isActive: false, timestamp: null } }),
    );

    assert.equal(result.classification, "inactive-unconfirmed");
    assert.equal(result.finalization, "unconfirmed");
    assert.equal(result.recoveryState, "none");
    assert.ok(result.reasons.includes("finalization-unconfirmed"));
    assert.ok(result.reasons.includes("stop-evidence-missing"));
  });

  it("distingue una finalización respaldada por evidencia de DETENER de la misma jornada", () => {
    const activeTrip = evaluate(tripObservation("trip-1"));

    const result = evaluate(
      tripObservation("trip-1", {
        current: { isActive: false, timestamp: null },
        planned: { stopEvidence: { stoppedAt: NOW - 5_000 } },
      }),
      activeTrip,
    );

    assert.equal(result.classification, "inactive-finalized");
    assert.equal(result.finalization, "confirmed");
    assert.ok(result.reasons.includes("finalization-confirmed"));
  });

  it("no confirma una finalización con evidencia inválida", () => {
    const activeTrip = evaluate(tripObservation("trip-1"));

    const result = evaluate(
      tripObservation("trip-1", {
        current: { isActive: false, timestamp: null },
        planned: { stopEvidence: { stoppedAt: 0 } },
      }),
      activeTrip,
    );

    assert.equal(result.classification, "inactive-unconfirmed");
    assert.equal(result.finalization, "unconfirmed");
    assert.ok(result.reasons.includes("stop-evidence-invalid"));
    assert.ok(result.reasons.includes("finalization-unconfirmed"));
  });

  it("no confirma una finalización con evidencia de DETENER demasiado futura", () => {
    const activeTrip = evaluate(tripObservation("trip-1"));

    const result = evaluate(
      tripObservation("trip-1", {
        current: { isActive: false, timestamp: null },
        planned: {
          stopEvidence: { stoppedAt: NOW + CONFIG.maxFutureSkewMs + 1 },
        },
      }),
      activeTrip,
    );

    assert.equal(result.classification, "inactive-unconfirmed");
    assert.equal(result.finalization, "unconfirmed");
    assert.ok(result.reasons.includes("stop-evidence-invalid"));
  });

  it("no reutiliza la evidencia de DETENER de otra jornada", () => {
    const activeTrip = evaluate(tripObservation("trip-1"));

    const result = evaluate(
      tripObservation("trip-2", {
        current: { isActive: false, timestamp: null },
        planned: { stopEvidence: { stoppedAt: NOW - 5_000 } },
      }),
      activeTrip,
    );

    assert.equal(result.classification, "inactive-unconfirmed");
    assert.equal(result.finalization, "unconfirmed");
    assert.ok(result.reasons.includes("stop-evidence-unverified"));
    assert.ok(!result.reasons.includes("finalization-confirmed"));
  });

  it("no verifica la evidencia de DETENER sin una jornada previa identificada", () => {
    const result = evaluate(
      tripObservation("trip-1", {
        current: { isActive: false, timestamp: null },
        planned: { stopEvidence: { stoppedAt: NOW - 5_000 } },
      }),
    );

    assert.equal(result.classification, "inactive-unconfirmed");
    assert.ok(result.reasons.includes("stop-evidence-unverified"));
  });

  it("no inicia recuperación cuando el recorrido quedó inactivo", () => {
    const interrupted = evaluate(staleObservation());

    const inactive = evaluate(
      makeObservation({
        evaluatedAt: NOW + 60_000,
        current: { isActive: false, timestamp: null },
      }),
      interrupted,
    );

    assert.equal(inactive.classification, "inactive-unconfirmed");
    assert.equal(inactive.recoveryState, "none");
  });
});

describe("recuperación", () => {
  it("queda pendiente con la primera publicación válida y confirma con dos distintas", () => {
    const interrupted = evaluate(staleObservation());

    const firstValid = evaluate(
      makeObservation({
        evaluatedAt: NOW + 60_000,
        current: { timestamp: NOW + 50_000 },
      }),
      interrupted,
    );

    assert.equal(firstValid.classification, "recovering-pending");
    assert.equal(firstValid.recoveryState, "pending");
    assert.equal(firstValid.recoveryValidObservations, 1);
    assert.ok(firstValid.reasons.includes("recovery-pending"));

    const secondValid = evaluate(
      makeObservation({
        evaluatedAt: NOW + 120_000,
        current: { timestamp: NOW + 110_000 },
      }),
      firstValid,
    );

    assert.equal(secondValid.classification, "recovering-confirmed");
    assert.equal(secondValid.recoveryState, "confirmed");
    assert.equal(secondValid.recoveryValidObservations, 2);
    assert.ok(secondValid.reasons.includes("recovery-confirmed"));

    const settled = evaluate(
      makeObservation({
        evaluatedAt: NOW + 180_000,
        current: { timestamp: NOW + 170_000 },
      }),
      secondValid,
    );

    assert.equal(settled.classification, "active-publishing");
    assert.equal(settled.recoveryState, "none");
  });

  it("no cuenta dos veces la misma publicación como observación de recuperación", () => {
    const interrupted = evaluate(staleObservation());

    const firstValid = evaluate(
      makeObservation({
        evaluatedAt: NOW + 60_000,
        current: { timestamp: NOW + 50_000 },
      }),
      interrupted,
    );

    const repeated = evaluate(
      makeObservation({
        evaluatedAt: NOW + 60_000,
        current: { timestamp: NOW + 50_000 },
      }),
      firstValid,
    );

    assert.equal(repeated.recoveryState, "pending");
    assert.equal(repeated.recoveryValidObservations, 1);

    const nextValid = evaluate(
      makeObservation({
        evaluatedAt: NOW + 120_000,
        current: { timestamp: NOW + 110_000 },
      }),
      repeated,
    );

    assert.equal(nextValid.recoveryState, "confirmed");
    assert.equal(nextValid.recoveryValidObservations, 2);
  });

  it("reinicia la confirmación si vuelve a interrumpirse durante la recuperación", () => {
    const interrupted = evaluate(staleObservation());

    const pending = evaluate(
      makeObservation({
        evaluatedAt: NOW + 60_000,
        current: { timestamp: NOW + 50_000 },
      }),
      interrupted,
    );

    const interruptedAgain = evaluate(
      makeObservation({
        evaluatedAt: NOW + 240_000,
        current: { timestamp: NOW + 50_000 },
      }),
      pending,
    );

    assert.equal(interruptedAgain.classification, "active-publication-stale");
    assert.equal(interruptedAgain.recoveryState, "none");
    assert.ok(
      interruptedAgain.reasons.includes("recovery-reset-by-interruption"),
    );

    const recoveredAgain = evaluate(
      makeObservation({
        evaluatedAt: NOW + 300_000,
        current: { timestamp: NOW + 290_000 },
      }),
      interruptedAgain,
    );

    assert.equal(recoveredAgain.classification, "recovering-pending");
    assert.equal(recoveredAgain.recoveryValidObservations, 1);
  });

  it("conserva una recuperación pendiente cuando el estado actual no se puede determinar", () => {
    const interrupted = evaluate(staleObservation());

    const pending = evaluate(
      makeObservation({
        evaluatedAt: NOW + 60_000,
        current: { timestamp: NOW + 50_000 },
      }),
      interrupted,
    );

    assert.equal(pending.recoveryState, "pending");

    const unknown = evaluate(
      makeObservation({
        evaluatedAt: NOW + 120_000,
        current: { isActive: null, timestamp: NOW + 110_000 },
      }),
      pending,
    );

    assert.equal(unknown.classification, "insufficient-data");
    assert.equal(unknown.recoveryState, "pending");
    assert.equal(unknown.recoveryValidObservations, 1);
  });
});

describe("configuración y pureza", () => {
  it("usa los umbrales recibidos y no valores fijos", () => {
    const observation = makeObservation({
      current: { timestamp: NOW - 90_000 },
    });
    const strict: TrackingEvaluationConfig = {
      ...CONFIG,
      publicationStaleAfterMs: 60_000,
    };
    const relaxed: TrackingEvaluationConfig = {
      ...CONFIG,
      publicationStaleAfterMs: 120_000,
    };

    assert.equal(
      evaluate(observation, null, strict).classification,
      "active-publication-stale",
    );
    assert.equal(
      evaluate(observation, null, relaxed).classification,
      "active-publishing",
    );
  });

  it("confirma la recuperación con la cantidad configurada de observaciones", () => {
    const interrupted = evaluate(staleObservation());
    const firstValidObservation = makeObservation({
      evaluatedAt: NOW + 60_000,
      current: { timestamp: NOW + 50_000 },
    });

    const withOne = evaluate(firstValidObservation, interrupted, {
      ...CONFIG,
      recoveryConfirmationsRequired: 1,
    });
    const withThree = evaluate(firstValidObservation, interrupted, {
      ...CONFIG,
      recoveryConfirmationsRequired: 3,
    });

    assert.equal(withOne.classification, "recovering-confirmed");
    assert.equal(withThree.classification, "recovering-pending");
    assert.equal(withThree.recoveryValidObservations, 1);
  });

  it("rechaza un reloj de evaluación inválido", () => {
    assert.throws(
      () => evaluate(makeObservation({ evaluatedAt: Number.NaN })),
      RangeError,
    );
  });

  it("rechaza configuraciones inválidas", () => {
    assert.throws(
      () =>
        evaluate(makeObservation(), null, {
          ...CONFIG,
          publicationStaleAfterMs: -1,
        }),
      RangeError,
    );
    assert.throws(
      () =>
        evaluate(makeObservation(), null, {
          ...CONFIG,
          maxFutureSkewMs: -1,
        }),
      RangeError,
    );
    assert.throws(
      () =>
        evaluate(makeObservation(), null, {
          ...CONFIG,
          recoveryConfirmationsRequired: 1.5,
        }),
      RangeError,
    );
    assert.throws(
      () =>
        evaluate(makeObservation(), null, {
          ...CONFIG,
          recoveryConfirmationsRequired: 0,
        }),
      RangeError,
    );
  });

  it("no modifica la observación, el estado previo ni la configuración", () => {
    const observation = makeObservation({
      planned: { gpsFixId: "fix-1", gpsFixTimestamp: NOW - 20_000 },
    });
    const previous = deepFreeze(
      evaluate(
        makeObservation({
          planned: { gpsFixId: "fix-0", gpsFixTimestamp: NOW - 30_000 },
        }),
      ),
    );
    const config = deepFreeze({ ...CONFIG });

    const observationSnapshot = structuredClone(observation);
    const previousSnapshot = structuredClone(previous);
    const configSnapshot = structuredClone(config);

    evaluateTracking({ observation, previous, config });

    assert.deepEqual(observation, observationSnapshot);
    assert.deepEqual(previous, previousSnapshot);
    assert.deepEqual(config, configSnapshot);
  });
});
