CREATE TABLE IF NOT EXISTS products (
  id INT PRIMARY KEY,
  name TEXT NOT NULL,
  price NUMERIC NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO products (id, name, price)
VALUES
  (1, 'Widget', 19.99),
  (2, 'Gadget', 49.50),
  (3, 'Doohickey', 7.25)
ON CONFLICT (id) DO NOTHING;
