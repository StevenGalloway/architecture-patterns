CREATE TABLE IF NOT EXISTS items (
  id INT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO items (id, value)
VALUES
  (1, 'alpha'),
  (2, 'bravo'),
  (3, 'charlie')
ON CONFLICT (id) DO NOTHING;
