# Vessel Class Finder: IACS Vessel Classification API

Look up any ship's **classification society, class status (In Class / Suspended / Withdrawn) and survey dates by IMO number** through a JSON REST API.

IACS publishes its *Vessels in Class* dataset only as a ZIP/CSV download. This project scrapes that file weekly, loads it into PostgreSQL, and serves it through authenticated endpoints.

- **Hosted API & free key:** https://tsolman.github.io/vessel-class-finder/ (100 lookups/month free)
- **Guide:** [How to query IACS class status by IMO number](https://tsolman.github.io/vessel-class-finder/blog/vessel-classification-api.html)
- **LLM-readable summary:** [`llms.txt`](https://tsolman.github.io/vessel-class-finder/llms.txt)
- **Built by** [WeAreFabbrik](https://wearefabbrik.com)

```bash
curl -X POST https://vessel-class-finder-production.up.railway.app/vessels \
  -H "x-api-key: YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"imos": [9200079]}'
```

## Prerequisites

- Node.js >= 18
- PostgreSQL database (e.g., Neon, Supabase, or local)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env.local` with the following variables:

```env
PGUSER=your_db_user
PGHOST=your_db_host
PGDATABASE=your_db_name
PGPASSWORD=your_db_password
DB_PORT=5432
PGSSLMODE=require
JWT_SECRET=your_jwt_secret

# Optional
ADMIN_API_KEY=long_random_secret      # enables POST /subscribe (disabled if unset)
RESEND_API_KEY=your_resend_key        # verification emails (skipped if unset)
APP_URL=https://your-api-host         # base URL for /verify links
SITE_URL=https://your-marketing-site  # links back to the signup page
TELEGRAM_BOT_TOKEN=...                # signup notifications
TELEGRAM_CHAT_ID=...
```

3. Create the required database tables:

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE api_keys (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  api_key TEXT UNIQUE NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE subscriptions (
  id SERIAL PRIMARY KEY,
  user_id UUID UNIQUE REFERENCES users(id),
  status TEXT NOT NULL,
  expires_at TIMESTAMP,
  plan TEXT DEFAULT 'starter'
);

CREATE TABLE api_usage (
  user_id UUID REFERENCES users(id),
  month TEXT NOT NULL,
  request_count INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, month)
);
```

The `vessel_data` table is created automatically by the scraper.

## Running the Scraper

```bash
node app.js
```

This will:
1. Scrape the latest IACS vessel classification ZIP from [iacs.org.uk](https://iacs.org.uk/membership/vessels-in-class)
2. Extract and parse the CSV
3. Load all records into PostgreSQL using a staging table (zero-downtime swap)
4. Schedule automatic weekly refresh (Sundays at 2:00 AM)

## Starting the API Server

```bash
node server.js
```

Server starts on port `3000` (or `PORT` env variable).

## API Endpoints

### Authentication

#### Register

```
POST /register
Content-Type: application/json

{ "email": "user@example.com", "password": "secret" }
```

Response: `{ "message": "Registered. Check your email to verify your account and activate your API key.", "userId": "uuid..." }`

A verification link is emailed to the user. Accounts must be verified before they can log in.

#### Verify Email

```
GET /verify?token=...
```

Opened from the link in the verification email. Links expire after 7 days.

#### Resend Verification Email

```
POST /resend-verification
Content-Type: application/json

{ "email": "user@example.com" }
```

Always responds with the same generic message, so it can't be used to check which emails are registered.

#### Login

```
POST /login
Content-Type: application/json

{ "email": "user@example.com", "password": "secret" }
```

Response: `{ "message": "Login successful", "token": "jwt...", "apiKey": "uuid..." }`

Returns your most recent active API key, creating one only if you have none. Email matching is case-insensitive.

Unverified accounts get `403` with `{ "error": "...", "unverified": true }`.

### Vessel Data (requires `x-api-key` header)

#### Fetch Vessels by IMO

```
POST /vessels
x-api-key: your-api-key
Content-Type: application/json

{ "imos": [9200079, 9300123] }
```

- Up to **100 IMO numbers** per request (duplicates are removed first).
- IMOs must be positive integers of up to 7 digits (numbers or numeric strings). Invalid input returns `400` with an `invalid` list and is not charged.
- Each unique IMO counts as **one lookup** against your monthly quota. IMOs not in the IACS dataset are omitted from the response.

Response:

```json
[
  {
    "imo": 9200079,
    "vessel_name": "EXAMPLE VESSEL",
    "update_date": "01/03/26",
    "class": "LR",
    "date_of_survey": "15/06/2025",
    "date_of_next_survey": "15/06/2028",
    "date_of_latest_status": "01/01/2024",
    "status": "In Class",
    "reason_for_status": ""
  }
]
```

### Subscriptions (requires `x-api-key` header)

#### Get Subscription Status

```
GET /subscription
x-api-key: your-api-key
```

Response: `{ "status": "active", "expires_at": "2026-04-23T00:00:00.000Z" }` or `{ "status": "inactive" }`

#### Activate Subscription (admin only)

```
POST /subscribe
x-admin-key: your-ADMIN_API_KEY
Content-Type: application/json

{ "email": "user@example.com", "plan": "pro" }
```

`plan` is one of `starter` (default), `pro`, `enterprise`. Activates or extends the plan for one month from now.

Response: `{ "message": "Subscription activated", "plan": "pro", "expires_at": "..." }`

Requires the `x-admin-key` header to match the `ADMIN_API_KEY` env variable. If `ADMIN_API_KEY` is unset, the endpoint always returns `403`.

### Usage (requires `x-api-key` header)

#### Check Current Usage

```
GET /usage
x-api-key: your-api-key
```

Response: `{ "month": "2026-03", "used": 47, "limit": 100, "plan": "free" }`

### Usage Limits

| Plan | Lookups/month | How to get |
|------|--------------|------------|
| Free | 100 | Register an account |
| Starter | 5,000 | Contact info@wearefabbrik.com |
| Pro | 50,000 | Contact info@wearefabbrik.com |
| Enterprise | Unlimited | Contact info@wearefabbrik.com |

Each unique IMO in a `/vessels` request counts as one lookup. If a request would take you over your monthly limit, `/vessels` returns `429` with `usage`, `requested`, `limit` and `plan`, and nothing is charged.

### API Key Management (requires `x-api-key` header)

#### List API Keys

```
GET /api-keys
x-api-key: your-api-key
```

Response: Array of `{ "api_key": "...", "active": true, "created_at": "..." }`

#### Revoke an API Key

```
DELETE /api-keys/:key
x-api-key: your-api-key
```

Response: `{ "message": "API key revoked" }`

### Error Responses

All errors return JSON with an `error` field:

```json
{ "error": "Invalid credentials" }
```

| Status | Meaning |
|--------|---------|
| 400 | Bad request (missing/invalid fields) |
| 401 | Invalid credentials |
| 403 | Missing or invalid API key, email not verified, or missing admin key |
| 404 | Resource not found |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

## Rate Limiting

| Scope | Limit |
|-------|-------|
| Global (all routes) | 100 requests / 15 min per IP |
| `/register`, `/login`, `/resend-verification` | 10 requests / 15 min per IP |
| `/register`, `/resend-verification` | 5 requests / hour per IP |

## Running Tests

```bash
npm test
```

Uses Vitest with mocked database and external dependencies. Tests cover utility functions, parameterized query construction, and all API routes.

## License

ISC
