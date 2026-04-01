with src as (
  select * from {{ ref('orders_raw') }}
)
select
  order_id,
  customer_id,
  cast(order_ts as timestamp) as order_ts,
  cast(order_total_usd as decimal(12,2)) as order_total_usd,
  status
from src
