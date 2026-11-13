CREATE TABLE tracking_state (
  source_key TEXT NOT NULL,
  bus_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  last_check_id TEXT NOT NULL,
  evaluated_at INTEGER NOT NULL,
  last_fresh_seen_at INTEGER,
  state_version INTEGER NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  last_classification TEXT NOT NULL,
  prior_state_json TEXT NOT NULL CHECK (json_valid(prior_state_json)),
  PRIMARY KEY (source_key, bus_id)
);

CREATE TABLE tracking_observations (
  check_id TEXT PRIMARY KEY NOT NULL,
  source_key TEXT NOT NULL,
  bus_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  evaluated_at INTEGER NOT NULL,
  source_status TEXT NOT NULL,
  source_error TEXT,
  declared_active INTEGER CHECK (declared_active IN (0, 1)),
  publication_timestamp INTEGER,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  UNIQUE (source_key, bus_id, revision),
  FOREIGN KEY (source_key, bus_id) REFERENCES tracking_state (source_key, bus_id)
);

CREATE INDEX tracking_observations_retention
  ON tracking_observations (source_key, bus_id, evaluated_at);
