# Vessel Class Finder

Data pipeline and REST API that scrapes IACS vessel classification data, loads it into PostgreSQL, and serves it via authenticated endpoints.

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
```

3. Create the required database tables:

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE api_keys (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  api_key TEXT UNIQUE NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id),
  status TEXT NOT NULL,
  expires_at TIMESTAMP
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

Response: `{ "message": "User registered", "userId": 1 }`

#### Login

```
POST /login
Content-Type: application/json

{ "email": "user@example.com", "password": "secret" }
```

Response: `{ "message": "Login successful", "token": "jwt...", "apiKey": "uuid..." }`

### Vessel Data (requires `x-api-key` header)

#### Fetch Vessels by IMO

```
POST /vessels
x-api-key: your-api-key
Content-Type: application/json

{ "imos": [9200079, 9300123] }
```

Response: Array of vessel records with IMO, name, class, survey dates, and status.

### Subscriptions (requires `x-api-key` header)

#### Get Subscription Status

```
GET /subscription
x-api-key: your-api-key
```

Response: `{ "status": "active", "expires_at": "2026-04-23T00:00:00.000Z" }` or `{ "status": "inactive" }`

#### Activate Subscription

```
POST /subscribe
x-api-key: your-api-key
Content-Type: application/json

{ "email": "user@example.com" }
```

Response: `{ "message": "Subscription activated" }`

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

## Rate Limiting

| Scope | Limit |
|-------|-------|
| Global (all routes) | 100 requests / 15 min per IP |
| `/register`, `/login` | 10 requests / 15 min per IP |

## Running Tests

```bash
npm test
```

Uses Vitest with mocked database and external dependencies. Tests cover utility functions, parameterized query construction, and all API routes.

## License

ISC
