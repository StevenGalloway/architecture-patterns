# Anti-Corruption Layer Example (Node/Express)

## What this demonstrates
- `vendor-system-mock` returns a **vendor-shaped DTO** with inconsistent naming/types/enums
- `acl-adapter` translates vendor DTO → **CanonicalCustomer**
- `core-domain-service` depends only on the canonical model and never sees vendor DTOs

## Run
```bash
docker compose up --build
```

## Try it
Call the core domain API (it calls ACL, which calls vendor):
- `curl http://localhost:3000/customers/123`

Call the ACL directly:
- `curl http://localhost:3001/customers/123`

Call the vendor directly (shows “weird” DTO):
- `curl http://localhost:3002/vendor/customer?id=123`
