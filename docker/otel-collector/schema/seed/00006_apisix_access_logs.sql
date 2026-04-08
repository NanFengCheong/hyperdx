-- +goose Up
CREATE TABLE IF NOT EXISTS ${DATABASE}.apisix_access_logs
(
  `Timestamp` DateTime64(9) DEFAULT now64(9) CODEC(Delta(8), ZSTD(1)),
  `TimestampTime` DateTime DEFAULT toDateTime(Timestamp),
  `ServiceName` LowCardinality(String) DEFAULT 'msm-apisix' CODEC(ZSTD(1)),
  `Body` String DEFAULT '' CODEC(ZSTD(1)),
  `TraceId` String DEFAULT '' CODEC(ZSTD(1)),

  -- APISIX route / service identification
  `route_id` String DEFAULT '' CODEC(ZSTD(1)),
  `route_name` String DEFAULT '' CODEC(ZSTD(1)),
  `service_id` String DEFAULT '' CODEC(ZSTD(1)),
  `consumer_name` String DEFAULT '' CODEC(ZSTD(1)),

  -- Request
  `request_method` LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
  `request_uri` String DEFAULT '' CODEC(ZSTD(1)),
  `request_url` String DEFAULT '' CODEC(ZSTD(1)),
  `request_headers` String DEFAULT '{}' CODEC(ZSTD(1)),
  `request_querystring` String DEFAULT '{}' CODEC(ZSTD(1)),
  `request_size` UInt64 DEFAULT 0,
  `request_body` String DEFAULT '' CODEC(ZSTD(1)),

  -- Response
  `response_status` UInt16 DEFAULT 0 CODEC(ZSTD(1)),
  `response_headers` String DEFAULT '{}' CODEC(ZSTD(1)),
  `response_size` UInt64 DEFAULT 0,
  `response_body` String DEFAULT '' CODEC(ZSTD(1)),

  -- Network / upstream
  `client_ip` String DEFAULT '' CODEC(ZSTD(1)),
  `upstream` String DEFAULT '' CODEC(ZSTD(1)),
  `upstream_status` String DEFAULT '' CODEC(ZSTD(1)),
  `upstream_addr` String DEFAULT '' CODEC(ZSTD(1)),
  `upstream_latency` Float64 DEFAULT 0,
  `apisix_latency` Float64 DEFAULT 0,
  `latency` Float64 DEFAULT 0,

  -- Server
  `server_hostname` LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
  `server_version` LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),

  -- Timing
  `start_time` DateTime64(3) DEFAULT 0,

  -- Indexes
  INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_route_id route_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_client_ip client_ip TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_status response_status TYPE minmax GRANULARITY 1,
  INDEX idx_latency latency TYPE minmax GRANULARITY 1,
  INDEX idx_request_body request_body TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 8,
  INDEX idx_response_body response_body TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 8
)
ENGINE = MergeTree
PARTITION BY toDate(TimestampTime)
PRIMARY KEY (ServiceName, TimestampTime)
ORDER BY (ServiceName, TimestampTime, Timestamp)
TTL TimestampTime + ${TABLES_TTL}
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1;
