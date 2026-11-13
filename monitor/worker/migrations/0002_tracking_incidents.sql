ALTER TABLE tracking_state ADD COLUMN monitoring_active INTEGER NOT NULL DEFAULT 0 CHECK (monitoring_active IN (0, 1));

-- Conservar la última declaración conocida al migrar una memoria existente.
UPDATE tracking_state SET monitoring_active = COALESCE(
  (SELECT declared_active FROM tracking_observations AS observation
   WHERE observation.source_key = tracking_state.source_key AND observation.bus_id = tracking_state.bus_id
     AND declared_active IS NOT NULL ORDER BY revision DESC LIMIT 1),
  CASE WHEN last_classification IN ('active-publishing', 'active-publication-stale', 'recovering-pending', 'recovering-confirmed') THEN 1 ELSE 0 END
);

CREATE TABLE tracking_incidents (
  incident_id TEXT PRIMARY KEY NOT NULL,
  source_key TEXT NOT NULL,
  bus_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tracking-interrupted', 'source-unavailable')),
  opened_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= opened_at),
  closed_at INTEGER,
  close_reason TEXT CHECK (close_reason IN ('publications-recovered', 'tracking-inactive', 'source-accessible')),
  duration_ms INTEGER,
  check_count INTEGER NOT NULL CHECK (check_count > 0),
  last_check_id TEXT NOT NULL,
  CHECK ((closed_at IS NULL AND close_reason IS NULL AND duration_ms IS NULL) OR
    (closed_at IS NOT NULL AND close_reason IS NOT NULL AND duration_ms = closed_at - opened_at AND closed_at >= opened_at)),
  FOREIGN KEY (source_key, bus_id) REFERENCES tracking_state (source_key, bus_id)
);

CREATE UNIQUE INDEX tracking_incidents_one_open
  ON tracking_incidents (source_key, bus_id, kind) WHERE closed_at IS NULL;
