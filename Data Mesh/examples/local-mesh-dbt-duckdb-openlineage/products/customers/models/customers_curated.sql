with src as (
  select * from {{ ref('customers_raw') }}
)
select
  customer_id,
  email,
  cast(created_ts as timestamp) as created_ts,
  country
from src
