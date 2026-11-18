ALTER TABLE tracking_state ADD COLUMN observed_trip_started_at INTEGER
  CHECK (observed_trip_started_at IS NULL OR
    (typeof(observed_trip_started_at) = 'integer' AND observed_trip_started_at > 0 AND observed_trip_started_at <= evaluated_at));
